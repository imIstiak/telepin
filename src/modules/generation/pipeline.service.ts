import { and, eq, inArray } from "drizzle-orm";
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
import { renderQuoteImage } from "../images/renderer.service";
import { buildBackgroundPrompt, isImageStyle, isTypographyPreset, type ImageStyle } from "../images/styles";
import { notifier } from "../notifications/notifier";
import { buildObjectKey, getStorage } from "../storage/r2.service";
import { getSettings, getUser } from "../users/user.service";

export class StaleJobError extends Error {}

async function loadGenerating(draftId: string, version: number): Promise<PinDraft | null> {
  const d = await db.query.pinDrafts.findFirst({ where: eq(pinDrafts.id, draftId) });
  if (!d || d.version !== version || d.status !== "GENERATING") return null; // superseded by a newer edit
  return d;
}

function quoteOptions(settings: Awaited<ReturnType<typeof getSettings>>) {
  return {
    language: settings.defaultLanguage,
    tone: settings.tone,
    quoteLength: (["short", "medium", "long"].includes(settings.quoteLength) ? settings.quoteLength : "medium") as QuoteLength,
    imageStyle: (isImageStyle(settings.defaultImageStyle) ? settings.defaultImageStyle : "auto") as ImageStyle | "auto",
  };
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
    ...quoteOptions(settings),
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
    ...quoteOptions(settings),
    imageStyle: isImageStyle(d.imageStyle) ? d.imageStyle : "auto",
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
  const style: ImageStyle = isImageStyle(d.imageStyle) ? d.imageStyle : "dark_cinematic";
  const prompt = buildBackgroundPrompt(style, d.backgroundPrompt);
  let buffer: Buffer;
  let usedPrompt = prompt;
  try {
    buffer = await getImageProvider().generateBackground(prompt, { style });
  } catch (e) {
    const permanent = e instanceof AIProviderError && !e.retryable;
    if (!isFinalAttempt && !permanent) throw e;
    logger.warn({ draftId: d.id, err: errMessage(e) }, "AI background failed on final attempt; using procedural fallback");
    buffer = await gradientFallback().generateBackground(prompt, { style });
    usedPrompt = `[fallback:procedural-gradient after AI error: ${errMessage(e).slice(0, 200)}] ${prompt}`;
  }
  const storage = getStorage();
  const key = buildObjectKey({ userId: d.userId, batchId: d.batchId, draftId: d.id, kind: "background", version: d.version, ext: "png" });
  const { prepareBackground } = await import("../images/renderer.service");
  const prepared = await prepareBackground(buffer);
  const stored = await storage.put(key, prepared, "image/png");
  const [asset] = await db
    .insert(imageAssets)
    .values({ draftId: d.id, objectKey: stored.objectKey, publicUrl: stored.publicUrl, assetType: "BACKGROUND", imageStyle: style, generationPrompt: usedPrompt, width: 1000, height: 1500, mimeType: "image/png", version: d.version })
    .returning();
  const [u] = await db
    .update(pinDrafts)
    .set({ backgroundImageId: asset!.id })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, job.version)))
    .returning();
  if (!u) return;
  await getQueues().render.add("render", { draftId: d.id, version: job.version, notify: job.notify }, { jobId: `render-${d.id}-v${job.version}` });
}

/** image-rendering: quote typography over the background → final JPEG → storage → ready for review. */
export async function runRender(job: RenderJob) {
  const d = await loadGenerating(job.draftId, job.version);
  if (!d || !d.quote) return;
  if (!d.backgroundImageId) throw new Error("Draft has no background image");
  const bgAsset = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, d.backgroundImageId) });
  if (!bgAsset) throw new Error("Background asset missing");
  const settings = await getSettings(d.userId);
  const user = await getUser(d.userId);
  const storage = getStorage();
  const background = await storage.get(bgAsset.objectKey);
  const style: ImageStyle = isImageStyle(d.imageStyle) ? d.imageStyle : "dark_cinematic";
  const typography = isTypographyPreset(d.typography) ? d.typography : "elegant_serif";
  const watermark = settings.watermarkEnabled ? settings.watermarkText || (user?.telegramUsername ? `@${user.telegramUsername}` : null) : null;
  const out = await renderQuoteImage({ background, quote: d.quote, style, typography, watermark, quality: settings.imageQuality });
  const key = buildObjectKey({ userId: d.userId, batchId: d.batchId, draftId: d.id, kind: "final", version: d.version, ext: "jpg" });
  const stored = await storage.put(key, out.buffer, out.mimeType);
  const [asset] = await db
    .insert(imageAssets)
    .values({ draftId: d.id, objectKey: stored.objectKey, publicUrl: stored.publicUrl, assetType: "FINAL", imageStyle: style, generationPrompt: bgAsset.generationPrompt, width: out.width, height: out.height, mimeType: out.mimeType, version: d.version })
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
