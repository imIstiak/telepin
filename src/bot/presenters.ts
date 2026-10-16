import { InputFile, type Api } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import { eq, inArray } from "drizzle-orm";
import { db } from "../config/database";
import { imageAssets, pinterestBoards, type PinBatch, type PinDraft } from "../db/schema";
import { listBatchDrafts } from "../modules/batches/draft.service";
import { getAccount } from "../modules/pinterest/oauth.service";
import { IMAGE_STYLES, isImageStyle } from "../modules/images/styles";
import { getStorage } from "../modules/storage/r2.service";
import { clampText, escapeHtml } from "../utils/text";
import { formatLocal, minutesLabel, buildTimeline } from "../utils/time";
import { batchSummaryKeyboard, draftKeyboard } from "./keyboards";

const STATUS_LABEL: Record<string, string> = {
  CREATED: "Queued",
  GENERATING: "Generating…",
  READY_FOR_REVIEW: "Ready",
  NEEDS_EDIT: "Needs edit",
  APPROVED: "Approved ✅",
  SCHEDULED: "Scheduled 🗓",
  PUBLISHING: "Publishing…",
  PUBLISHED: "Published 📌",
  FAILED: "Failed ⚠️",
  CANCELLED: "Rejected/Cancelled",
  PUBLISH_UNKNOWN: "Publish outcome unknown — checking",
};
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

async function boardNames(ids: (string | null)[]) {
  const clean = ids.filter((x): x is string => Boolean(x));
  if (!clean.length) return new Map<string, string>();
  const rows = await db.select({ id: pinterestBoards.id, name: pinterestBoards.name }).from(pinterestBoards).where(inArray(pinterestBoards.id, clean));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function batchSummaryText(b: PinBatch): Promise<string> {
  const drafts = await listBatchDrafts(b.id);
  const names = await boardNames(drafts.map((d) => d.selectedBoardId));
  const acc = await getAccount(b.userId);
  const ready = drafts.filter((d) => d.selectedImageId && !["CANCELLED", "FAILED", "GENERATING"].includes(d.status)).length;
  const lines = drafts.map((d) => {
    const label = d.topic && d.quote ? escapeHtml(clampText(d.topic, 40)) : "—";
    const board = d.selectedBoardId ? ` → <i>${escapeHtml(names.get(d.selectedBoardId) ?? "?")}</i>` : "";
    return `${d.position}. ${label} — ${statusLabel(d.status)}${board}`;
  });
  const scheduled = drafts.some((d) => ["SCHEDULED", "PUBLISHING", "PUBLISHED", "PUBLISH_UNKNOWN"].includes(d.status));
  return [
    `<b>Batch #${b.number}</b>`,
    ``,
    `Topic: ${escapeHtml(b.originalTopic)}`,
    `Generated Pins: ${b.generatedCount}/${b.requestedCount}`,
    `Images Ready: ${ready}`,
    `Pinterest Connected: ${acc?.connectionStatus === "CONNECTED" ? "Yes" : "No — use /connect"}`,
    `Board Assignment: ${b.boardAssignmentMode === "AUTO" ? "Auto" : b.boardAssignmentMode === "UNIQUE" ? "Unique boards" : "Manual"}`,
    `Publishing: ${scheduled ? "Scheduled (see /queue)" : "Not Scheduled"}`,
    `Status: ${b.status.replace(/_/g, " ").toLowerCase()}`,
    ``,
    ...lines,
    b.lastError ? `\n⚠️ ${escapeHtml(clampText(b.lastError, 300))}` : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export async function draftCaption(d: PinDraft, header?: string): Promise<string> {
  const batch = await db.query.pinBatches.findFirst({ where: (t, { eq: e }) => e(t.id, d.batchId) });
  const names = await boardNames([d.selectedBoardId]);
  const board = d.selectedBoardId ? `${escapeHtml(names.get(d.selectedBoardId) ?? "?")}${d.boardReason ? ` <i>(${escapeHtml(clampText(d.boardReason, 80))})</i>` : ""}` : "<i>not assigned</i>";
  const style = isImageStyle(d.imageStyle) ? IMAGE_STYLES[d.imageStyle].label : d.imageStyle ?? "—";
  const parts = [
    header ? `<b>${escapeHtml(header)}</b>` : null,
    `<b>Pin ${d.position}/${batch?.requestedCount ?? "?"}</b> · Batch #${batch?.number ?? "?"} · ${statusLabel(d.status)}`,
    d.quote ? `\n“${escapeHtml(d.quote)}”\n` : "",
    `<b>Title:</b> ${escapeHtml(d.title ?? "—")}`,
    `<b>Description:</b> ${escapeHtml(clampText(d.description ?? "—", 380))}`,
    `<b>Board:</b> ${board}`,
    d.link ? `<b>Link:</b> ${escapeHtml(clampText(d.link, 80))}` : null,
    `<b>Style:</b> ${escapeHtml(style)} · v${d.version}`,
    d.lastError ? `⚠️ ${escapeHtml(clampText(d.lastError, 200))}` : null,
  ].filter((x): x is string => x !== null);
  // Telegram photo captions are limited to 1024 characters.
  let text = parts.join("\n");
  if (text.length > 1024) text = parts.join("\n").replace(/<b>Description:<\/b>[^\n]*\n/, "<b>Description:</b> (long — tap Edit Description to view)\n").slice(0, 1020);
  return text;
}

export async function finalImageFor(d: PinDraft) {
  if (!d.selectedImageId) return null;
  return (await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, d.selectedImageId) })) ?? null;
}

/** Sends a pin preview (photo + caption + action keyboard), or text if no image exists yet. */
export async function sendDraftCard(api: Api, chatId: string | number, d: PinDraft, header?: string) {
  const caption = await draftCaption(d, header);
  const asset = await finalImageFor(d);
  const keyboard = draftKeyboard(d, asset?.publicUrl);
  if (!asset) return api.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: keyboard });
  const buf = await getStorage().get(asset.objectKey);
  return api.sendPhoto(chatId, new InputFile(buf, `pin-${d.position}.jpg`), { caption, parse_mode: "HTML", reply_markup: keyboard });
}

export async function sendBatchSummary(api: Api, chatId: string | number, b: PinBatch, header?: string) {
  const text = (header ? `${header}\n\n` : "") + (await batchSummaryText(b));
  return api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: batchSummaryKeyboard(b), link_preview_options: { is_disabled: true } });
}

/** Album preview of all finished images in a batch (max 10 per album). */
export async function sendBatchAlbum(api: Api, chatId: string | number, b: PinBatch) {
  const drafts = (await listBatchDrafts(b.id)).filter((d) => d.selectedImageId && d.status !== "CANCELLED");
  if (drafts.length === 0) return;
  const media: InputMediaPhoto[] = [];
  for (const d of drafts.slice(0, 10)) {
    const asset = await finalImageFor(d);
    if (!asset) continue;
    const buf = await getStorage().get(asset.objectKey);
    media.push({ type: "photo", media: new InputFile(buf, `pin-${d.position}.jpg`), caption: `Pin ${d.position}: ${clampText(d.title ?? "", 200)}` });
  }
  if (media.length === 1) {
    await api.sendPhoto(chatId, media[0]!.media as InputFile, { caption: media[0]!.caption });
  } else if (media.length > 1) {
    await api.sendMediaGroup(chatId, media);
  }
}

export function scheduleReviewText(b: PinBatch, drafts: PinDraft[], names: Map<string, string>): string {
  const plan = b.schedulePlan!;
  const times = buildTimeline(new Date(plan.startAt), drafts.length, plan.intervalMinutes);
  const rows = drafts.map(
    (d, i) => `${formatLocal(times[i]!, plan.timezone, "dd LLL, hh:mm a")} → Pin ${d.position} → <i>${escapeHtml(names.get(d.selectedBoardId!) ?? "?")}</i>\n     ${escapeHtml(clampText(d.title ?? "", 70))}`,
  );
  return [
    `<b>Final review — Batch #${b.number}</b>`,
    ``,
    `Pins: ${drafts.length}`,
    `First publish: ${formatLocal(new Date(plan.startAt), plan.timezone)}`,
    `Interval: ${minutesLabel(plan.intervalMinutes)}`,
    `Timezone: ${plan.timezone}`,
    ``,
    ...rows,
    ``,
    `Nothing is published until you tap <b>Confirm Schedule</b>.`,
  ].join("\n");
}

export { boardNames };
