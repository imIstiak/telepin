import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../config/database";
import { errMessage, logger } from "../../config/logger";
import { imageAssets, pinBatches, pinDrafts, type PinDraft } from "../../db/schema";
import { getQueues, type BackgroundJob, type RenderJob } from "../../queues";
import { AIProviderError } from "../ai/provider.interface";
import { gradientFallback, getImageProvider, getTextProvider } from "../ai/providers";
import { QuoteService, type QuoteLength } from "../ai/quote.service";
import { listBatchDrafts, recentQuotes } from "../batches/draft.service";
import { autoAssignBoards, refreshBatchStatus } from "../batches/batch.service";
import { ensureBoards } from "../pinterest/boards.service";
import { getAccount } from "../pinterest/oauth.service";
import { hammingDistance, perceptualHash, renderQuoteImage } from "../images/renderer.service";
import { buildBackgroundPrompt, isImageStyle, isTypographyPreset, resolveStyle, STYLE_SYSTEM_VERSION, suggestStyle, type ImageStyle } from "../images/styles";
import { notifier } from "../notifications/notifier";
import { buildObjectKey, getStorage } from "../storage/r2.service";
import { getSettings } from "../users/user.service";

export class StaleJobError extends Error {}

async function loadGenerating(draftId: string, version: number): Promise<PinDraft | null> {
  const d = await db.query.pinDrafts.findFirst({ where: eq(pinDrafts.id, draftId) });
  if (!d || d.version !== version || d.status !== "GENERATING") return null; // superseded by a newer edit
  return d;
}

/** Max AI backgrounds per pin version (first try + one automatic retry for poor contrast / near-duplicates). */
export const MAX_BACKGROUND_ATTEMPTS = 2;
/** dHash distance at or below which two backgrounds in a batch count as near-identical. */
export const NEAR_DUPLICATE_DISTANCE = 6;

function quoteOptions(settings: Awaited<ReturnType<typeof getSettings>>, style: unknown) {
  return {
    language: settings.defaultLanguage,
    tone: settings.tone,
    quoteLength: (["short", "medium", "long"].includes(settings.quoteLength) ? settings.quoteLength : "medium") as QuoteLength,
    // The style chosen before generation (batch level) always overrides the AI; "auto" = AI chooses semantically.
    imageStyle: (isImageStyle(style) ? style : "auto") as ImageStyle | "auto",
  };
}

async function backgroundAttempts(draftId: string, version: number) {
  const rows = await db
    .select({ id: imageAssets.id })
    .from(imageAssets)
    .where(and(eq(imageAssets.draftId, draftId), eq(imageAssets.version, version), eq(imageAssets.assetType, "BACKGROUND")));
  return rows.length;
}

async function enqueueBackgroundRetry(d: PinDraft, version: number, notify: "batch" | "draft", attempt: number) {
  await getQueues().background.add("bg", { draftId: d.id, version, notify }, { jobId: `bg-${d.id}-v${version}-a${attempt}` });
}

/** content-generation (batch): quotes + SEO for every pending draft in one model call, then fan out image jobs. */
export async function runBatchContent(batchId: string) {
  const batch = await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) });
  if (!batch || batch.status === "CANCELLED") return;
  const drafts = (await listBatchDrafts(batchId)).filter((d) => d.status === "GENERATING" && !d.quote);
  if (drafts.length === 0) return;
  const settings = await getSettings(batch.userId);
  const svc = new QuoteService(getTextProvider());
  const items = await svc.generateBatch({
    topic: batch.originalTopic,
    count: drafts.length,
    existingQuotes: await recentQuotes(batch.userId),
    ...quoteOptions(settings, batch.imageStyle),
  });

  for (const [i, d] of drafts.entries()) {
    const item = items[i];
    if (!item) {
      await db
        .update(pinDrafts)
        .set({ status: "FAILED", lastError: "Could not produce a sufficiently unique quote. Use Regenerate to try again." })
        .where(eq(pinDrafts.id, d.id));
      continue;
    }
    await db
      .update(pinDrafts)
      .set({
        topic: item.topic,
        emotion: item.emotion,
        quote: item.quote,
        title: item.title,
        description: item.description,
        keywords: item.keywords,
        altText: item.alt_text,
        imageStyle: item.style,
        backgroundPrompt: item.background_prompt,
      })
      .where(eq(pinDrafts.id, d.id));
    await getQueues().background.add("bg", { draftId: d.id, version: d.version, notify: "batch" }, { jobId: `bg-${d.id}-v${d.version}` });
  }
  const { becameReady } = await refreshBatchStatus(batchId);
  if (becameReady) await onBatchReady(batchId);
}

/** When a batch finishes generating: apply the user's default board mode (AUTO/UNIQUE), then notify. */
export async function onBatchReady(batchId: string) {
  try {
    const batch = await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) });
    if (batch && batch.generatedCount > 0 && batch.boardAssignmentMode !== "MANUAL") {
      const acc = await getAccount(batch.userId);
      if (acc?.connectionStatus === "CONNECTED" && (await ensureBoards(batch.userId)).length) {
        await autoAssignBoards(batch.userId, batchId, batch.boardAssignmentMode);
      }
    }
  } catch (e) {
    logger.warn({ batchId, err: errMessage(e) }, "Automatic board assignment skipped");
  }
  await notifier.batchReady(batchId);
}

/** content-generation (rewrite): new quote + metadata for one pin. */
export async function runRewrite(draftId: string, version: number, thenBackground: boolean) {
  const d = await loadGenerating(draftId, version);
  if (!d) return;
  const settings = await getSettings(d.userId);
  const siblings = (await listBatchDrafts(d.batchId)).map((s) => s.quote).filter((q): q is string => Boolean(q));
  const svc = new QuoteService(getTextProvider());
  const item = await svc.rewriteOne({
    topic: d.topic,
    existingQuotes: [...siblings, ...(await recentQuotes(d.userId))],
    ...quoteOptions(settings, d.imageStyle),
  });
  await db
    .update(pinDrafts)
    .set({
      quote: item.quote,
      title: item.title,
      description: item.description,
      keywords: item.keywords,
      altText: item.alt_text,
      emotion: item.emotion,
      backgroundPrompt: thenBackground ? item.background_prompt : d.backgroundPrompt,
    })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, version)));
  if (thenBackground || !d.backgroundImageId) await getQueues().background.add("bg", { draftId, version, notify: "draft" }, { jobId: `bg-${draftId}-v${version}` });
  else await getQueues().render.add("render", { draftId, version, notify: "draft" }, { jobId: `render-${draftId}-v${version}` });
}

/** background-generation: AI background → storage. Falls back to a procedural background only on the final attempt. */
export async function runBackground(job: BackgroundJob, isFinalAttempt: boolean) {
  const d = await loadGenerating(job.draftId, job.version);
  if (!d) return;
  const style: ImageStyle = resolveStyle(d.imageStyle, suggestStyle(`${d.topic} ${d.quote ?? ""}`));
  const attempt = await backgroundAttempts(d.id, d.version);
  // Different lighting/framing/material per pin (and per retry) so a batch never looks copy-pasted.
  const variant = d.position - 1 + attempt * 3 + (d.version - 1);
  const prompt = buildBackgroundPrompt(style, d.backgroundPrompt, variant);
  const tag = `[style:${style} system:v${STYLE_SYSTEM_VERSION} variant:${variant}]`;
  let buffer: Buffer;
  let usedPrompt = `${tag} ${prompt}`;
  let isFallback = false;
  try {
    buffer = await getImageProvider().generateBackground(prompt, { style });
  } catch (e) {
    const permanent = e instanceof AIProviderError && !e.retryable;
    if (!isFinalAttempt && !permanent) throw e;
    logger.warn({ draftId: d.id, err: errMessage(e) }, "AI background failed on final attempt; using procedural fallback");
    buffer = await gradientFallback().generateBackground(prompt, { style });
    usedPrompt = `[fallback:procedural-gradient after AI error: ${errMessage(e).slice(0, 200)}] ${tag} ${prompt}`;
    isFallback = true;
  }
  const storage = getStorage();
  const key = buildObjectKey({ userId: d.userId, batchId: d.batchId, draftId: d.id, kind: "background", version: d.version, ext: "png" });
  const { prepareBackground } = await import("../images/renderer.service");
  const prepared = await prepareBackground(buffer);
  const phash = await perceptualHash(prepared);
  const stored = await storage.put(key.replace(/\.png$/, attempt ? `-a${attempt}.png` : ".png"), prepared, "image/png");
  const [asset] = await db
    .insert(imageAssets)
    .values({ draftId: d.id, objectKey: stored.objectKey, publicUrl: stored.publicUrl, assetType: "BACKGROUND", imageStyle: style, styleVersion: STYLE_SYSTEM_VERSION, isFallback, phash, generationPrompt: usedPrompt, width: 1000, height: 1500, mimeType: "image/png", version: d.version })
    .returning();
  // Batch variation check: if this background is nearly identical to a sibling's, try once more with another variant.
  if (!isFallback && attempt + 1 < MAX_BACKGROUND_ATTEMPTS && (await nearDuplicateInBatch(d, phash))) {
    logger.info({ draftId: d.id }, "Background nearly identical to another pin in the batch; regenerating with a new variation");
    return enqueueBackgroundRetry(d, job.version, job.notify, attempt + 1);
  }
  const [u] = await db
    .update(pinDrafts)
    .set({ backgroundImageId: asset!.id })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, job.version)))
    .returning();
  if (!u) return;
  await getQueues().render.add("render", { draftId: d.id, version: job.version, notify: job.notify }, { jobId: `render-${d.id}-v${job.version}` });
}

async function nearDuplicateInBatch(d: PinDraft, phash: string): Promise<boolean> {
  const siblings = await db
    .select({ phash: imageAssets.phash })
    .from(imageAssets)
    .innerJoin(pinDrafts, eq(pinDrafts.id, imageAssets.draftId))
    .where(and(eq(pinDrafts.batchId, d.batchId), ne(pinDrafts.id, d.id), eq(imageAssets.assetType, "BACKGROUND")))
    .orderBy(desc(imageAssets.createdAt))
    .limit(50);
  return siblings.some((s) => s.phash && hammingDistance(s.phash, phash) <= NEAR_DUPLICATE_DISTANCE);
}

/** image-rendering: quote typography over the background → final JPEG → storage → ready for review. */
export async function runRender(job: RenderJob) {
  const d = await loadGenerating(job.draftId, job.version);
  if (!d || !d.quote) return;
  if (!d.backgroundImageId) throw new Error("Draft has no background image");
  const bgAsset = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, d.backgroundImageId) });
  if (!bgAsset) throw new Error("Background asset missing");
  const settings = await getSettings(d.userId);
  const storage = getStorage();
  const background = await storage.get(bgAsset.objectKey);
  const style: ImageStyle = resolveStyle(bgAsset.imageStyle ?? d.imageStyle);
  // null typography → the style's own typeface; an explicit per-pin/settings preset overrides it.
  const typography = isTypographyPreset(d.typography) ? d.typography : null;
  const quality = Math.min(92, Math.max(90, settings.imageQuality));
  const out = await renderQuoteImage({ background, quote: d.quote, style, typography, quality });
  if (!out.qa.contrastOk && !bgAsset.isFallback) {
    const attempts = await backgroundAttempts(d.id, d.version);
    if (attempts < MAX_BACKGROUND_ATTEMPTS) {
      logger.info({ draftId: d.id, contrast: out.qa.contrast }, "Quote contrast too low on every region; regenerating the background");
      return enqueueBackgroundRetry(d, job.version, job.notify, attempts);
    }
  }
  const key = buildObjectKey({ userId: d.userId, batchId: d.batchId, draftId: d.id, kind: "final", version: d.version, ext: "jpg" });
  const stored = await storage.put(key, out.buffer, out.mimeType);
  const [asset] = await db
    .insert(imageAssets)
    .values({ draftId: d.id, objectKey: stored.objectKey, publicUrl: stored.publicUrl, assetType: "FINAL", imageStyle: style, styleVersion: STYLE_SYSTEM_VERSION, isFallback: bgAsset.isFallback, phash: bgAsset.phash, qa: { ...out.qa, region: out.region, layout: out.layout, veil: out.veilStrength, fontSize: out.fontSize, textColor: out.textColor, typography: out.typography }, generationPrompt: bgAsset.generationPrompt, width: out.width, height: out.height, mimeType: out.mimeType, version: d.version })
    .returning();
  const [u] = await db
    .update(pinDrafts)
    .set({ selectedImageId: asset!.id, status: "READY_FOR_REVIEW", lastError: null })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, job.version), eq(pinDrafts.status, "GENERATING")))
    .returning();
  if (!u) return;
  await afterDraftSettled(u, job.notify);
}

export async function markDraftFailed(draftId: string, version: number, error: unknown, notify: "batch" | "draft") {
  const [u] = await db
    .update(pinDrafts)
    .set({ status: "FAILED", lastError: errMessage(error).slice(0, 500) })
    .where(and(eq(pinDrafts.id, draftId), eq(pinDrafts.version, version), eq(pinDrafts.status, "GENERATING")))
    .returning();
  if (u) await afterDraftSettled(u, notify);
}

export async function markBatchContentFailed(batchId: string, error: unknown) {
  await db
    .update(pinDrafts)
    .set({ status: "FAILED", lastError: errMessage(error).slice(0, 500) })
    .where(and(eq(pinDrafts.batchId, batchId), inArray(pinDrafts.status, ["GENERATING", "CREATED"])));
  await db.update(pinBatches).set({ lastError: errMessage(error).slice(0, 500) }).where(eq(pinBatches.id, batchId));
  const { becameReady } = await refreshBatchStatus(batchId);
  if (becameReady) await onBatchReady(batchId);
}

async function afterDraftSettled(d: PinDraft, notify: "batch" | "draft") {
  const { becameReady } = await refreshBatchStatus(d.batchId);
  if (notify === "draft") await notifier.draftCard(d.id, { header: d.status === "FAILED" ? "⚠️ Regeneration failed" : "✨ Updated pin" });
  else if (becameReady) await onBatchReady(d.batchId);
}
