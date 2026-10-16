import type { Update } from "grammy/types";
import { createBot } from "../../src/bot/bot";
import { setTelegramApi } from "../../src/modules/notifications/notifier";

export interface SentCall {
  method: string;
  payload: Record<string, any>;
}

/** A bot wired to a fake Telegram API that records every outgoing call. */
export function createTestBot() {
  const bot = createBot("123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz");
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "QuoteBot",
    username: "quote_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as any;
  const calls: SentCall[] = [];
  let messageId = 1;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    let result: unknown = true;
    if (method.startsWith("send") || method.startsWith("edit")) result = { message_id: messageId++, date: 0, chat: { id: 111, type: "private" }, text: "" };
    if (method === "sendMediaGroup") result = [{ message_id: messageId++, date: 0, chat: { id: 111, type: "private" } }];
    return { ok: true, result } as any;
  });
  setTelegramApi(bot.api);

  let updateId = 1;
  const from = (id: number) => ({ id, is_bot: false, first_name: "Istiak", username: "istiak" });
  const send = (text: string, userId = 111) => {
    const entities = text.startsWith("/") ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] : undefined;
    return bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: "private", first_name: "Istiak" }, from: from(userId), text, entities },
    } as Update);
  };
  const click = (data: string, userId = 111, withPhoto = false) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: from(userId),
        chat_instance: "x",
        data,
        message: withPhoto
          ? { message_id: 5, date: 0, chat: { id: userId, type: "private", first_name: "I" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }], caption: "c" }
          : { message_id: 5, date: 0, chat: { id: userId, type: "private", first_name: "I" }, text: "t" },
      },
    } as Update);

  const texts = () => calls.filter((c) => ["sendMessage", "editMessageText"].includes(c.method)).map((c) => String(c.payload.text));
  const lastText = () => texts().at(-1) ?? "";
  /** Find a button's callback_data by (partial) label in the most recent messages. */
  const button = (label: string): string => {
    for (const c of [...calls].reverse()) {
      const rows = c.payload.reply_markup?.inline_keyboard as { text: string; callback_data?: string }[][] | undefined;
      for (const row of rows ?? []) for (const b of row) if (b.text.includes(label) && b.callback_data) return b.callback_data;
    }
    throw new Error(`Button "${label}" not found`);
  };
  return { bot, calls, send, click, texts, lastText, button };
}
