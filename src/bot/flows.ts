import { InlineKeyboard } from "grammy";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../config/database";
import { errMessage } from "../config/logger";
import { pinDrafts, pinSchedules, type PinBatch, type PinDraft } from "../db/schema";
import { getQueues } from "../queues";
import { autoAssignBoards, createBatch, getOwnedBatch, listBatches, validateCount, validateTopic } from "../modules/batches/batch.service";
import { IMAGE_STYLES, type ImageStyle } from "../modules/images/styles";
import { getSettings, setPendingAction } from "../modules/users/user.service";
import { getOwnedDraft, listBatchDrafts } from "../modules/batches/draft.service";
import { ensureBoards } from "../modules/pinterest/boards.service";
import { proposePlan, upcomingQueue } from "../modules/scheduling/schedule.service";
import { clampText, escapeHtml } from "../utils/text";
import { formatLocal, minutesLabel } from "../utils/time";
import { cb } from "./callbacks";
import type { BotContext } from "./context";
import { boardPickerKeyboard, newBatchStyleKeyboard, queueBatchKeyboard, scheduleConfirmKeyboard } from "./keyboards";
import { boardNames, scheduleReviewText, sendBatchSummary, sendDraftCard } from "./presenters";

/** Step before generation: let the user choose a visual style (or Auto). Nothing is generated until they pick. */
export async function askStyle(ctx: BotContext, topic: string, count: number) {
  validateTopic(topic);
  validateCount(count);
  await setPendingAction(ctx.user.id, { kind: "choose_style", topic, count });
  const s = await getSettings(ctx.user.id);
  await ctx.reply(
    `🎨 <b>Choose a style</b> for ${count} Pin${count === 1 ? "" : "s"} about “${escapeHtml(clampText(topic, 80))}”\n\n<i>Auto</i> lets the AI match each quote's emotion to the best style. A style you pick is used for every Pin in this batch.`,
    { parse_mode: "HTML", reply_markup: newBatchStyleKeyboard(s.defaultImageStyle) },
  );
}

export async function startGeneration(ctx: BotContext, topic: string, count: number, style: ImageStyle | "auto" = "auto") {
  const batch = await createBatch(ctx.user.id, topic, count, style);
  const styleLabel = style === "auto" ? "✨ Auto style" : `${IMAGE_STYLES[style].emoji} ${IMAGE_STYLES[style].label}`;
  await ctx.reply(
    `⏳ Generating ${count} Pinterest quote Pin${count === 1 ? "" : "s"} for “${escapeHtml(clampText(topic, 80))}” · ${styleLabel} (Batch #${batch.number}). Please wait — I'll send the previews here.`,
    { parse_mode: "HTML" },
  );
}

export async function showBatchSummary(ctx: BotContext, batchId: string, header?: string) {
  const b = await getOwnedBatch(ctx.user.id, batchId);
  await sendBatchSummary(ctx.api, ctx.chat!.id, b, header);
}

export async function previewBatch(ctx: BotContext, batchId: string) {
  const b = await getOwnedBatch(ctx.user.id, batchId);
  const drafts = (await listBatchDrafts(b.id)).filter((d) => d.status !== "CANCELLED");
  if (!drafts.length) return void (await ctx.reply("No pins to preview in this batch."));
  for (const d of drafts) await sendDraftCard(ctx.api, ctx.chat!.id, d);
}

export async function latestBatch(ctx: BotContext): Promise<PinBatch | null> {
  const [b] = await listBatches(ctx.user.id, 1);
  return b ?? null;
}

/** Re-renders a pin card in place when possible (caption/text + keyboard), otherwise sends a new one. */
export async function refreshDraftCard(ctx: BotContext, d: PinDraft, header?: string) {
  const { draftCaption, finalImageFor } = await import("./presenters");
  const { draftKeyboard } = await import("./keyboards");
  const caption = await draftCaption(d, header);
  const asset = await finalImageFor(d);
  const reply_markup = draftKeyboard(d, asset?.publicUrl);
  try {
    if (ctx.callbackQuery?.message && "photo" in ctx.callbackQuery.message && ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption({ caption, parse_mode: "HTML", reply_markup });
    } else if (ctx.callbackQuery?.message && !("photo" in ctx.callbackQuery.message && ctx.callbackQuery.message.photo) && !asset) {
      await ctx.editMessageText(caption, { parse_mode: "HTML", reply_markup });
    } else {
      await sendDraftCard(ctx.api, ctx.chat!.id, d, header);
    }
  } catch (e) {
    if (!/message is not modified/.test(errMessage(e))) await sendDraftCard(ctx.api, ctx.chat!.id, d, header);
  }
}

export async function showBoardPicker(ctx: BotContext, draftId: string, page: number, mode: "single" | "sequence", edit = false) {
  const d = await getOwnedDraft(ctx.user.id, draftId);
  const boards = await ensureBoards(ctx.user.id);
  if (!boards.length) {
    return void (await ctx.reply("No Pinterest boards available. Connect with /connect (boards are never created automatically)."));
  }
  const text = `📌 Choose a board for <b>Pin ${d.position}</b>:\n“${escapeHtml(clampText(d.quote ?? "", 160))}”`;
  const reply_markup = boardPickerKeyboard(d, boards, page, mode === "single" ? { select: "cbs", page: "cb" } : { select: "mbs", page: "mbp" });
  if (edit) {
    try {
      return void (await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }));
    } catch {
      /* fall through to a new message */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup });
}

/** Next pin in the batch (by position) for the sequential manual board flow. */
export async function nextDraftForManual(batchId: string, afterPosition: number) {
  const [n] = await db
    .select()
    .from(pinDrafts)
    .where(and(eq(pinDrafts.batchId, batchId), gt(pinDrafts.position, afterPosition), inArray(pinDrafts.status, ["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED"])))
    .orderBy(asc(pinDrafts.position))
    .limit(1);
  return n ?? null;
}

export async function runAutoAssign(ctx: BotContext, batchId: string, mode: "AUTO" | "UNIQUE") {
  await ensureBoards(ctx.user.id);
  const res = await autoAssignBoards(ctx.user.id, batchId, mode);
  const drafts = await listBatchDrafts(batchId);
  const names = await boardNames(drafts.map((d) => d.selectedBoardId));
  const lines = res.assignments.map((a) => {
    const d = drafts.find((x) => x.id === a.draftId)!;
    return `${d.position}. ${escapeHtml(clampText(d.topic, 30))} → ${a.boardId ? `<b>${escapeHtml(names.get(a.boardId) ?? "?")}</b>` : "<i>needs manual choice</i>"}\n    <i>${escapeHtml(clampText(a.reason, 90))}</i>`;
  });
  let note = "";
  if (mode === "UNIQUE" && res.insufficientBoards) {
    note = `\n\n⚠️ Only ${res.assignments.length - res.unassigned.length} distinct relevant boards were found for ${res.assignments.length} pins (you have ${res.boardCount} boards). Assign the rest manually, reject some pins, or use Auto Assign (boards may repeat).`;
  } else if (res.unassigned.length) {
    note = `\n\n⚠️ ${res.unassigned.length} pin(s) had no relevant board — please choose manually.`;
  }
  const kb = new InlineKeyboard();
  if (res.unassigned.length) {
    const first = drafts.find((d) => d.id === res.unassigned[0]);
    if (first) kb.text("📌 Choose missing boards", cb("mbp", first.id, first.version, 0)).row();
  }
  kb.text("✅ Approve & Schedule", cb("bs", batchId)).text("⬅️ Batch", cb("bsum", batchId));
  await ctx.reply(`🤖 <b>Board recommendations (${mode === "UNIQUE" ? "unique boards" : "auto"})</b>\n\n${lines.join("\n")}${note}\n\nYou can change any pin's board from its preview.`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

export async function showScheduleReview(ctx: BotContext, batchId: string, startAt: Date, intervalMinutes: number) {
  const { batch, drafts, skipped } = await proposePlan(ctx.user.id, batchId, startAt, intervalMinutes);
  const names = await boardNames(drafts.map((d) => d.selectedBoardId));
  const text = scheduleReviewText(batch, drafts, names) + (skipped.length ? `\n\nℹ️ ${skipped.join("; ")}` : "");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: scheduleConfirmKeyboard(batch) });
}

export async function showQueue(ctx: BotContext, onlyBatchId?: string) {
  const rows = (await upcomingQueue(ctx.user.id)).filter((r) => !onlyBatchId || r.schedule.batchId === onlyBatchId);
  if (!rows.length) return void (await ctx.reply("🗓 Nothing is scheduled. Generate pins and use “Approve & Schedule”."));
  const byBatch = new Map<string, typeof rows>();
  for (const r of rows) byBatch.set(r.schedule.batchId, [...(byBatch.get(r.schedule.batchId) ?? []), r]);
  for (const [batchId, items] of byBatch) {
    const tz = items[0]!.schedule.timezone;
    const paused = items.some((i) => i.schedule.status === "PAUSED");
    const lines = items.map((i) => {
      const st = i.schedule.status === "SCHEDULED" ? "" : ` [${i.schedule.status.toLowerCase().replace("_", " ")}]`;
      return `${formatLocal(i.schedule.scheduledAt, tz, "dd LLL, hh:mm a")} → Pin ${i.draft.position} → <i>${escapeHtml(i.boardName)}</i>${st}`;
    });
    await ctx.reply(`🗓 <b>Batch #${items[0]!.batchNumber}</b> (${minutesLabel(items[0]!.schedule.intervalMinutes)}, ${tz})\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
      reply_markup: queueBatchKeyboard(batchId, paused),
    });
  }
}

export async function pendingQueueCount(userId: string) {
  const rows = await db.select({ id: pinSchedules.id }).from(pinSchedules).where(and(eq(pinSchedules.userId, userId), eq(pinSchedules.status, "SCHEDULED")));
  return rows.length;
}

export async function enqueueRegeneration(d: PinDraft, kind: "background" | "render" | "rewrite" | "everything") {
  const q = getQueues();
  if (kind === "background" || (kind === "render" && !d.backgroundImageId)) {
    await q.background.add("bg", { draftId: d.id, version: d.version, notify: "draft" }, { jobId: `bg-${d.id}-v${d.version}` });
  } else if (kind === "render") {
    await q.render.add("render", { draftId: d.id, version: d.version, notify: "draft" }, { jobId: `render-${d.id}-v${d.version}` });
  } else {
    await q.content.add("rewrite", { kind: "rewrite", draftId: d.id, version: d.version, thenBackground: kind === "everything" }, { jobId: `rewrite-${d.id}-v${d.version}` });
  }
}
