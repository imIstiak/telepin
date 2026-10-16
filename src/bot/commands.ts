import { InlineKeyboard, type Composer } from "grammy";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../config/database";
import { env, integrationStatus } from "../config/env";
import { pinBatches, pinDrafts } from "../db/schema";
import { getBatchByNumber, listBatches, validateCount } from "../modules/batches/batch.service";
import { syncBoards } from "../modules/pinterest/boards.service";
import { createAuthorizationUrl, getAccount, pinterestConfigured } from "../modules/pinterest/oauth.service";
import { pauseBatch, publishHistory, resumeBatch, upcomingQueue } from "../modules/scheduling/schedule.service";
import { getSettings, setPendingAction } from "../modules/users/user.service";
import { clampText, escapeHtml } from "../utils/text";
import { formatLocal } from "../utils/time";
import { cb } from "./callbacks";
import type { BotContext } from "./context";
import { askStyle, latestBatch, previewBatch, showBatchSummary, showQueue } from "./flows";
import { publishOptionsKeyboard } from "./keyboards";
import { statusLabel } from "./presenters";
import { showSettings } from "./handlers/settings";

export const COMMANDS: { command: string; description: string }[] = [
  { command: "create", description: "Generate one Pin: /create <topic>" },
  { command: "bulk", description: "Generate 3/5/7 Pins: /bulk 7 <topic>" },
  { command: "boards", description: "List (and sync) Pinterest boards" },
  { command: "connect", description: "Connect your Pinterest account" },
  { command: "account", description: "Pinterest connection status" },
  { command: "drafts", description: "Pins waiting for review" },
  { command: "batches", description: "Recent batches" },
  { command: "preview", description: "Preview a batch: /preview <#>" },
  { command: "schedule", description: "Schedule a batch: /schedule <#>" },
  { command: "queue", description: "Upcoming scheduled Pins" },
  { command: "pause", description: "Pause scheduled publishing" },
  { command: "resume", description: "Resume paused publishing" },
  { command: "reschedule", description: "Change publishing time: /reschedule <#>" },
  { command: "history", description: "Published Pins" },
  { command: "settings", description: "Preferences" },
  { command: "cancel", description: "Cancel the current step" },
  { command: "help", description: "How to use the bot" },
];

const HELP = `<b>Pinterest AI Quote Agent</b>

Send keywords (e.g. <i>broken trust, dark emotional</i>) or <i>7 sad relationship quotes</i> and I'll ask how many pins and which style (10 styles or Auto) before creating anything.

<b>Generate</b>: /create &lt;topic&gt; · /bulk 3|5|7 &lt;topic&gt;
<b>Review</b>: /batches · /preview &lt;#&gt; · /drafts — edit, regenerate, change board, approve
<b>Boards</b>: /connect · /boards · Auto / Unique / Manual assignment from the batch menu
<b>Publish</b>: /schedule &lt;#&gt; → Publish now, hourly or custom → final review → Confirm
<b>Manage</b>: /queue · /pause · /resume · /reschedule &lt;#&gt; · /history
<b>Other</b>: /settings · /account · /cancel

Nothing is ever published without your explicit confirmation.`;

async function batchFromArg(ctx: BotContext, arg: string) {
  const n = Number(arg.replace("#", "").trim());
  if (arg.trim() && Number.isInteger(n)) {
    const b = await getBatchByNumber(ctx.user.id, n);
    if (!b) await ctx.reply(`Batch #${n} not found.`);
    return b ?? null;
  }
  const b = await latestBatch(ctx);
  if (!b) await ctx.reply("You don't have any batches yet. Send some keywords to start.");
  return b;
}

export function registerCommands(bot: Composer<BotContext>) {
  bot.command("start", async (ctx) => {
    const acc = await getAccount(ctx.user.id);
    const st = integrationStatus();
    await ctx.reply(
      `👋 Welcome${ctx.from?.first_name ? `, ${escapeHtml(ctx.from.first_name)}` : ""}! Access verified.\n\nPinterest: ${acc?.connectionStatus === "CONNECTED" ? `connected${acc.username ? ` as @${escapeHtml(acc.username)}` : ""}` : "not connected — /connect"}\nAI text: ${st.aiText ? "ready" : "not configured"} · AI images: ${st.aiImage ? "ready" : "not configured"} · Storage: ${st.storage ? "ready" : "not configured"}\n\n${HELP}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

  bot.command("create", async (ctx) => {
    const topic = ctx.match.trim();
    if (!topic) return ctx.reply("Usage: /create <topic>, e.g. /create self-love after breakup");
    await askStyle(ctx, topic, 1);
  });

  bot.command("bulk", async (ctx) => {
    const m = ctx.match.trim().match(/^(\d{1,2})\s+(.+)$/);
    if (!m) {
      const topic = ctx.match.trim();
      if (!topic) return ctx.reply("Usage: /bulk 3|5|7 <topic>, e.g. /bulk 5 broken trust");
      const s = await getSettings(ctx.user.id);
      return askStyle(ctx, topic, s.defaultBatchSize);
    }
    await askStyle(ctx, m[2]!, validateCount(Number(m[1])));
  });

  bot.command("connect", async (ctx) => {
    if (!pinterestConfigured()) return ctx.reply("⚠️ The Pinterest app credentials (PINTEREST_CLIENT_ID/SECRET/REDIRECT_URI) aren't configured on the server yet.");
    const url = await createAuthorizationUrl(ctx.user.id);
    await ctx.reply("🔐 Tap below to authorize this bot on Pinterest. The link expires in 15 minutes and works once.", {
      reply_markup: new InlineKeyboard().url("Connect Pinterest", url),
    });
  });

  bot.command("account", async (ctx) => {
    const acc = await getAccount(ctx.user.id);
    if (!acc) return ctx.reply("Pinterest is not connected. Use /connect.");
    await ctx.reply(
      `📌 Pinterest: <b>${acc.connectionStatus}</b>${acc.username ? ` as @${escapeHtml(acc.username)}` : ""}\nScopes: ${escapeHtml(acc.scopes ?? "?")}\nToken expires: ${acc.tokenExpiresAt ? formatLocal(acc.tokenExpiresAt, ctx.user.timezone) : "unknown"} (auto-refreshed)\nAPI: ${escapeHtml(env.PINTEREST_API_BASE)}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("boards", async (ctx) => {
    const acc = await getAccount(ctx.user.id);
    if (!acc) return ctx.reply("Pinterest is not connected. Use /connect.");
    const boards = await syncBoards(ctx.user.id);
    if (!boards.length) return ctx.reply("No boards found on your Pinterest account. Create boards on Pinterest first — this bot never creates boards automatically.");
    await ctx.reply(`📋 <b>${boards.length} boards</b> (synced just now)\n\n${boards.map((b, i) => `${i + 1}. ${escapeHtml(b.name)}${b.privacy && b.privacy !== "PUBLIC" ? ` <i>(${b.privacy.toLowerCase()})</i>` : ""}`).join("\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("batches", async (ctx) => {
    const rows = await listBatches(ctx.user.id, 10);
    if (!rows.length) return ctx.reply("No batches yet. Send some keywords to start.");
    const kb = new InlineKeyboard();
    rows.forEach((b) => kb.text(`#${b.number} ${clampText(b.originalTopic, 24)} · ${b.status.toLowerCase().replace(/_/g, " ")}`, cb("bsum", b.id)).row());
    await ctx.reply("🗂 Recent batches:", { reply_markup: kb });
  });

  bot.command("drafts", async (ctx) => {
    const rows = await db
      .select({ d: pinDrafts, n: pinBatches.number })
      .from(pinDrafts)
      .innerJoin(pinBatches, eq(pinBatches.id, pinDrafts.batchId))
      .where(and(eq(pinDrafts.userId, ctx.user.id), inArray(pinDrafts.status, ["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED"])))
      .orderBy(desc(pinDrafts.updatedAt))
      .limit(20);
    if (!rows.length) return ctx.reply("No drafts waiting for review.");
    const kb = new InlineKeyboard();
    rows.forEach(({ d, n }) => kb.text(`#${n}·${d.position} ${statusLabel(d.status)} — ${clampText(d.quote ?? d.topic, 28)}`, cb("pv", d.id)).row());
    await ctx.reply("📝 Saved drafts:", { reply_markup: kb });
  });

  bot.command("preview", async (ctx) => {
    const b = await batchFromArg(ctx, ctx.match);
    if (b) await previewBatch(ctx, b.id);
  });

  bot.command("schedule", async (ctx) => {
    const b = await batchFromArg(ctx, ctx.match);
    if (b) await ctx.reply(`🗓 <b>Publishing Options — Batch #${b.number}</b>`, { parse_mode: "HTML", reply_markup: publishOptionsKeyboard(b) });
  });

  bot.command("queue", (ctx) => showQueue(ctx));

  bot.command("pause", async (ctx) => {
    const ids = ctx.match.trim() ? [(await batchFromArg(ctx, ctx.match))?.id].filter(Boolean) : [...new Set((await upcomingQueue(ctx.user.id)).map((r) => r.schedule.batchId))];
    let n = 0;
    for (const id of ids) n += await pauseBatch(ctx.user.id, id!);
    await ctx.reply(n ? `⏸ Paused ${n} scheduled pin(s). /resume to continue.` : "Nothing to pause.");
  });

  bot.command("resume", async (ctx) => {
    const ids = ctx.match.trim() ? [(await batchFromArg(ctx, ctx.match))?.id].filter(Boolean) : [...new Set((await upcomingQueue(ctx.user.id)).map((r) => r.schedule.batchId))];
    let n = 0;
    for (const id of ids) n += (await resumeBatch(ctx.user.id, id!)).length;
    await ctx.reply(n ? `▶️ Resumed ${n} pin(s). See /queue.` : "Nothing is paused.");
  });

  bot.command("reschedule", async (ctx) => {
    const b = await batchFromArg(ctx, ctx.match);
    if (!b) return;
    await setPendingAction(ctx.user.id, { kind: "reschedule_start", batchId: b.id });
    await ctx.reply(`🕒 Send the new start time for Batch #${b.number} (${escapeHtml(ctx.user.timezone)}), e.g. <code>tomorrow 10:00</code>.`, { parse_mode: "HTML" });
  });

  bot.command("history", async (ctx) => {
    const rows = await publishHistory(ctx.user.id);
    if (!rows.length) return ctx.reply("No published pins yet.");
    const lines = rows.map(
      (r) => `• ${r.publishedAt ? formatLocal(r.publishedAt, ctx.user.timezone, "dd LLL, hh:mm a") : ""} — <a href="${escapeHtml(r.job.pinterestPinUrl ?? "")}">${escapeHtml(clampText(r.draft.title ?? "Pin", 60))}</a> → ${escapeHtml(r.boardName)}`,
    );
    await ctx.reply(`📚 <b>Published pins</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("settings", (ctx) => showSettings(ctx));

  bot.command("cancel", async (ctx) => {
    const had = Boolean(ctx.user.pendingAction);
    await setPendingAction(ctx.user.id, null);
    await db.update(pinBatches).set({ schedulePlan: null }).where(eq(pinBatches.userId, ctx.user.id));
    await ctx.reply(had ? "✖️ Cancelled the current step." : "Nothing to cancel. (To cancel a batch use its menu; to stop schedules use /queue.)");
  });
}

export { showBatchSummary };
