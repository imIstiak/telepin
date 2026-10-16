import { Api, InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { errMessage, logger } from "../../config/logger";
import { pinBatches, pinDrafts, users } from "../../db/schema";
import { cb } from "../../bot/callbacks";
import { sendBatchAlbum, sendBatchSummary, sendDraftCard } from "../../bot/presenters";
import { getSettings } from "../users/user.service";
import { escapeHtml } from "../../utils/text";

let api: Api | undefined;
export function getTelegramApi(): Api {
  if (!api) api = new Api(env.TELEGRAM_BOT_TOKEN || "0:missing");
  return api;
}
/** Test hook. */
export function setTelegramApi(a: Api) {
  api = a;
}

async function chatFor(userId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return u?.telegramChatId ?? u?.telegramUserId ?? null;
}

async function safe(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    logger.error({ err: errMessage(e), what }, "Telegram notification failed");
  }
}

export const notifier = {
  async batchReady(batchId: string) {
    const b = await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) });
    if (!b) return;
    const chat = await chatFor(b.userId);
    if (!chat) return;
    const ready = b.generatedCount;
    const header = ready === 0 ? "⚠️ Generation failed for this batch." : `🎉 Your ${ready} Pinterest Pin${ready === 1 ? " is" : "s are"} ready!`;
    await safe("batchReady", async () => {
      await sendBatchAlbum(getTelegramApi(), chat, b);
      await sendBatchSummary(getTelegramApi(), chat, b, header);
    });
  },

  async draftCard(draftId: string, opts: { header?: string } = {}) {
    const d = await db.query.pinDrafts.findFirst({ where: eq(pinDrafts.id, draftId) });
    if (!d) return;
    const chat = await chatFor(d.userId);
    if (!chat) return;
    await safe("draftCard", () => sendDraftCard(getTelegramApi(), chat, d, opts.header));
  },

  async text(userId: string, html: string, opts: { force?: boolean; keyboard?: InlineKeyboard } = {}) {
    const chat = await chatFor(userId);
    if (!chat) return;
    if (!opts.force) {
      const s = await getSettings(userId);
      if (!s.notificationsEnabled) return;
    }
    await safe("text", () => getTelegramApi().sendMessage(chat, html, { parse_mode: "HTML", reply_markup: opts.keyboard, link_preview_options: { is_disabled: true } }));
  },

  async published(userId: string, p: { position: number; batchNumber: number; batchId: string; boardName: string; pinUrl: string; title: string }) {
    const kb = new InlineKeyboard().url("📌 View Pinterest Pin", p.pinUrl).row().text("🗓 View Queue", cb("qv", p.batchId));
    await notifier.text(
      userId,
      `✅ <b>Pin ${p.position} Published Successfully!</b>\nBatch #${p.batchNumber}\n\n${escapeHtml(p.title)}\nBoard: ${escapeHtml(p.boardName)}\nStatus: Published`,
      { keyboard: kb },
    );
  },
};
