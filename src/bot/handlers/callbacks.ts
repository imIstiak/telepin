import { DateTime } from "luxon";
import type { Composer } from "grammy";
import { getQueues } from "../../queues";
import { getTextProvider } from "../../modules/ai/providers";
import { SeoService } from "../../modules/ai/seo.service";
import { approveAll, approveDraft, changeDraft, getOwnedDraft, listBatchDrafts, rejectDraft, StaleActionError } from "../../modules/batches/draft.service";
import { cancelBatch, createBatch, getOwnedBatch, setDraftBoard, validateCount } from "../../modules/batches/batch.service";
import { IMAGE_STYLE_KEYS, TYPOGRAPHY_KEYS } from "../../modules/images/styles";
import { cancelBatchSchedules, clearPlan, confirmPlan, pauseBatch, resumeBatch } from "../../modules/scheduling/schedule.service";
import { setPendingAction } from "../../modules/users/user.service";
import { escapeHtml } from "../../utils/text";
import { formatLocal, minutesLabel } from "../../utils/time";
import { parseCallback, type ParsedCallback } from "../callbacks";
import type { BotContext } from "../context";
import {
  enqueueRegeneration,
  nextDraftForManual,
  previewBatch,
  refreshDraftCard,
  runAutoAssign,
  showBatchSummary,
  showBoardPicker,
  showQueue,
  showScheduleReview,
  startGeneration,
} from "../flows";
import { batchEditListKeyboard, confirmKeyboard, intervalKeyboard, publishOptionsKeyboard, regenerateKeyboard, startTimeKeyboard, styleKeyboard, typographyKeyboard } from "../keyboards";
import { handleSettingsCallback } from "./settings";

type Handler = (ctx: BotContext, p: ParsedCallback) => Promise<unknown>;

const need = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new StaleActionError("This button is malformed or expired.");
  return v;
};

/** Draft id + version from args[0], args[1]; validates ownership and version. */
async function draftArg(ctx: BotContext, p: ParsedCallback, checkVersion = true) {
  const d = await getOwnedDraft(ctx.user.id, need(p.id(0)));
  if (checkVersion) {
    const v = need(p.int(1));
    if (v !== d.version) throw new StaleActionError();
  }
  return d;
}

const regen =
  (kind: "background" | "render" | "rewrite" | "everything", change: (ctx: BotContext, p: ParsedCallback) => Record<string, unknown> = () => ({}), label = "Regenerating") =>
  async (ctx: BotContext, p: ParsedCallback) => {
    const d0 = await draftArg(ctx, p);
    const d = await changeDraft(ctx.user.id, d0.id, d0.version, change(ctx, p), { status: "GENERATING", action: `draft.regenerate_${kind}` });
    await enqueueRegeneration(d, kind);
    await ctx.reply(`⏳ ${label} pin ${d.position}… I'll send the updated preview when it's ready.`);
  };

const askText = (kind: "edit_quote" | "edit_title" | "edit_description" | "edit_link", prompt: (d: { quote: string | null; title: string | null; description: string | null; link: string | null }) => string) => async (ctx: BotContext, p: ParsedCallback) => {
  const d = await draftArg(ctx, p);
  await setPendingAction(ctx.user.id, { kind, draftId: d.id, version: d.version });
  await ctx.reply(prompt(d), { parse_mode: "HTML" });
};

const handlers: Record<string, Handler> = {
  noop: async () => undefined,

  // ----- count chooser -----
  cnt: async (ctx, p) => {
    const n = validateCount(need(p.int(0)));
    const pending = ctx.user.pendingAction;
    if (pending?.kind !== "choose_count") throw new StaleActionError("Send your keywords again, then choose the number of pins.");
    await setPendingAction(ctx.user.id, null);
    await startGeneration(ctx, pending.topic, n);
  },

  // ----- batch level -----
  bsum: (ctx, p) => showBatchSummary(ctx, need(p.id(0))),
  bp: (ctx, p) => previewBatch(ctx, need(p.id(0))),
  be: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(`✏️ Which pin of Batch #${b.number} do you want to open?`, { reply_markup: batchEditListKeyboard(b, await listBatchDrafts(b.id)) });
  },
  bba: (ctx, p) => runAutoAssign(ctx, need(p.id(0)), "AUTO"),
  bbu: (ctx, p) => runAutoAssign(ctx, need(p.id(0)), "UNIQUE"),
  bbm: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    const first = await nextDraftForManual(b.id, 0);
    if (!first) return ctx.reply("No pins are ready for board selection.");
    await showBoardPicker(ctx, first.id, 0, "sequence");
  },
  baa: async (ctx, p) => {
    const batchId = need(p.id(0));
    const r = await approveAll(ctx.user.id, batchId);
    const parts = [`✅ Approved: ${r.approved.length ? r.approved.map((n) => `#${n}`).join(", ") : "none"}`];
    if (r.missingBoard.length) parts.push(`📌 Need a board first: ${r.missingBoard.map((n) => `#${n}`).join(", ")}`);
    if (r.notReady.length) parts.push(`⏳ Not ready: ${r.notReady.map((n) => `#${n}`).join(", ")}`);
    await ctx.reply(parts.join("\n"));
    await showBatchSummary(ctx, batchId);
  },
  bs: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(`🗓 <b>Publishing Options — Batch #${b.number}</b>\nYou'll see a full review before anything is scheduled.`, { parse_mode: "HTML", reply_markup: publishOptionsKeyboard(b) });
  },
  bc: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(`Cancel Batch #${b.number}? Pending schedules are cancelled; published pins are not affected.`, { reply_markup: confirmKeyboard("bcy", b.id) });
  },
  bcy: async (ctx, p) => {
    await cancelBatch(ctx.user.id, need(p.id(0)));
    await ctx.editMessageText("🗑 Batch cancelled.").catch(() => ctx.reply("🗑 Batch cancelled."));
  },

  // ----- scheduling -----
  sn: (ctx, p) => showScheduleReview(ctx, need(p.id(0)), new Date(), 0),
  sc: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply("⏱ Choose the interval between pins:", { reply_markup: intervalKeyboard(b) });
  },
  si: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    const minutes = need(p.int(1));
    await ctx.reply(`🕒 When should the first pin go out? (${minutesLabel(minutes)}, timezone ${ctx.user.timezone})`, { reply_markup: startTimeKeyboard(b, minutes) });
  },
  st: async (ctx, p) => {
    const batchId = need(p.id(0));
    await getOwnedBatch(ctx.user.id, batchId);
    const minutes = need(p.int(1));
    const code = p.args[2];
    const tz = ctx.user.timezone;
    const now = DateTime.now().setZone(tz);
    let start: Date;
    if (code === "now") start = new Date();
    else if (code === "1h") start = now.plus({ hours: 1 }).toJSDate();
    else if (code === "t10") start = now.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    else if (code === "t20") start = now.plus({ days: 1 }).set({ hour: 20, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    else if (code === "type") {
      await setPendingAction(ctx.user.id, { kind: "schedule_start", batchId, intervalMinutes: minutes });
      return ctx.reply(
        `⌨️ Send the first publishing date/time in <b>${escapeHtml(tz)}</b>.\nExamples: <code>2026-10-20 10:00</code>, <code>tomorrow 9:30</code>, <code>18:00</code>, <code>in 2h</code>`,
        { parse_mode: "HTML" },
      );
    } else throw new StaleActionError();
    await showScheduleReview(ctx, batchId, start, minutes);
  },
  sok: async (ctx, p) => {
    const batchId = need(p.id(0));
    const b = await getOwnedBatch(ctx.user.id, batchId);
    const created = await confirmPlan(ctx.user.id, batchId);
    const boards = new Set(created.map((s) => s.boardId)).size;
    const first = created[0]!;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.reply(
      `✅ <b>Batch #${b.number} scheduled successfully.</b>\n\n${created.length} Pins approved.\n${created.length} board assignments confirmed (${boards} distinct board${boards === 1 ? "" : "s"}).\nFirst: ${formatLocal(first.scheduledAt, first.timezone)}\nInterval: ${first.intervalMinutes} minutes.\n\nYou will receive a notification after each successful publication. Manage with /queue.`,
      { parse_mode: "HTML" },
    );
  },
  sx: async (ctx, p) => {
    await clearPlan(ctx.user.id, need(p.id(0)));
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.reply("✖️ Schedule not created. Nothing was published.");
  },

  // ----- queue -----
  qv: (ctx, p) => showQueue(ctx, need(p.id(0))),
  qp: async (ctx, p) => {
    const n = await pauseBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(`⏸ Paused ${n} scheduled pin(s).`);
  },
  qr: async (ctx, p) => {
    const rows = await resumeBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(rows.length ? `▶️ Resumed ${rows.length} pin(s). Next: ${formatLocal(rows[0]!.scheduledAt, rows[0]!.timezone)}` : "Nothing was paused.");
  },
  qx: async (ctx, p) => {
    const b = await getOwnedBatch(ctx.user.id, need(p.id(0)));
    await ctx.reply(`Cancel all pending schedules of Batch #${b.number}? Pins stay approved and can be rescheduled.`, { reply_markup: confirmKeyboard("qxy", b.id) });
  },
  qxy: async (ctx, p) => {
    const n = await cancelBatchSchedules(ctx.user.id, need(p.id(0)));
    await ctx.editMessageText(`🗑 Cancelled ${n} scheduled pin(s).`).catch(() => ctx.reply(`🗑 Cancelled ${n} scheduled pin(s).`));
  },
  rsc: async (ctx, p) => {
    const batchId = need(p.id(0));
    await getOwnedBatch(ctx.user.id, batchId);
    await setPendingAction(ctx.user.id, { kind: "reschedule_start", batchId });
    await ctx.reply(`🕒 Send the new start time for the remaining pins (${escapeHtml(ctx.user.timezone)}), e.g. <code>tomorrow 10:00</code>. Spacing stays the same.`, { parse_mode: "HTML" });
  },

  // ----- single pin -----
  pv: async (ctx, p) => {
    const d = await getOwnedDraft(ctx.user.id, need(p.id(0)));
    const { sendDraftCard } = await import("../presenters");
    await sendDraftCard(ctx.api, ctx.chat!.id, d);
  },
  eq: askText("edit_quote", (d) => `✏️ Send the new quote text.\n\nCurrent:\n<code>${escapeHtml(d.quote ?? "")}</code>\n\n/cancel to stop.`),
  et: askText("edit_title", (d) => `✏️ Send the new title (max 100 characters).\n\nCurrent:\n<code>${escapeHtml(d.title ?? "")}</code>`),
  ed: askText("edit_description", (d) => `✏️ Send the new description (max 800 characters).\n\nCurrent:\n<code>${escapeHtml(d.description ?? "")}</code>`),
  el: askText("edit_link", (d) => `🔗 Send the destination URL (https://…), or <code>none</code> to remove it.\n\nCurrent: ${escapeHtml(d.link ?? "none")}`),
  rg: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    await ctx.reply(`🔁 What should I regenerate for pin ${d.position}?`, { reply_markup: regenerateKeyboard(d) });
  },
  rgs: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    await ctx.editMessageReplyMarkup({ reply_markup: styleKeyboard(d) }).catch(() => ctx.reply("Choose a style:", { reply_markup: styleKeyboard(d) }));
  },
  rgt: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    await ctx.editMessageReplyMarkup({ reply_markup: typographyKeyboard(d) }).catch(() => ctx.reply("Choose typography:", { reply_markup: typographyKeyboard(d) }));
  },
  rgb: regen("background", undefined, "Generating a new background for"),
  rss: regen("background", (_c, p) => ({ imageStyle: need(IMAGE_STYLE_KEYS[need(p.int(2))]) }), "Changing the style of"),
  rst: regen("render", (_c, p) => ({ typography: need(TYPOGRAPHY_KEYS[need(p.int(2))]) }), "Changing typography of"),
  rgq: regen("rewrite", undefined, "Rewriting the quote of"),
  rga: regen("everything", undefined, "Regenerating everything for"),
  rgo: async (ctx, p) => {
    const d0 = await draftArg(ctx, p);
    await ctx.reply("⏳ Writing fresh title, description and alt text…");
    const seo = await new SeoService(getTextProvider()).generate({ quote: d0.quote ?? "", topic: d0.topic, language: "same as the quote", style: d0.imageStyle ?? "" });
    const d = await changeDraft(ctx.user.id, d0.id, d0.version, { title: seo.title, description: seo.description, keywords: seo.keywords, altText: seo.alt_text }, { action: "draft.seo_regenerated" });
    const { sendDraftCard } = await import("../presenters");
    await sendDraftCard(ctx.api, ctx.chat!.id, d, "🔍 SEO text updated");
  },
  ap: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    const u = await approveDraft(ctx.user.id, d.id, d.version);
    await refreshDraftCard(ctx, u);
  },
  rj: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    const u = await rejectDraft(ctx.user.id, d.id, d.version);
    await refreshDraftCard(ctx, u);
  },

  // ----- boards -----
  cb: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    await showBoardPicker(ctx, d.id, p.int(2) ?? 0, "single", Boolean(ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message));
  },
  cbs: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    const { draft, board, duplicateOf } = await setDraftBoard(ctx.user.id, d.id, d.version, need(p.id(2)));
    await ctx.editMessageText(`📌 Pin ${draft.position} → <b>${escapeHtml(board.name)}</b>${duplicateOf.length ? `\n(also used by pin ${duplicateOf.join(", ")})` : ""}`, { parse_mode: "HTML" }).catch(() => undefined);
    const { sendDraftCard } = await import("../presenters");
    await sendDraftCard(ctx.api, ctx.chat!.id, draft);
  },
  mbp: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    await showBoardPicker(ctx, d.id, p.int(2) ?? 0, "sequence", true);
  },
  mbs: async (ctx, p) => {
    const d = await draftArg(ctx, p);
    const { draft, board } = await setDraftBoard(ctx.user.id, d.id, d.version, need(p.id(2)));
    await ctx.editMessageText(`📌 Pin ${draft.position} → <b>${escapeHtml(board.name)}</b>`, { parse_mode: "HTML" }).catch(() => undefined);
    const next = await nextDraftForManual(draft.batchId, draft.position);
    if (next) await showBoardPicker(ctx, next.id, 0, "sequence");
    else await showBatchSummary(ctx, draft.batchId, "✅ Manual board selection finished.");
  },
};

export function registerCallbacks(bot: Composer<BotContext>) {
  bot.on("callback_query:data", async (ctx) => {
    const p = parseCallback(ctx.callbackQuery.data);
    if (p?.action === "set" || p?.action === "setv" || p?.action === "spb") {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return handleSettingsCallback(ctx, p);
    }
    const h = p ? handlers[p.action] : undefined;
    if (!p || !h) {
      await ctx.answerCallbackQuery({ text: "This button has expired.", show_alert: false });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
    await h(ctx, p);
  });
}

export const _test = { handlers, getQueues, createBatch };
