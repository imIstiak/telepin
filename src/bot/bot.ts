import { Bot, GrammyError, type BotError } from "grammy";
import { env } from "../config/env";
import { errMessage, logger } from "../config/logger";
import { InvalidStateError, NotFoundError, StaleActionError } from "../modules/batches/draft.service";
import { ReconnectRequiredError } from "../modules/pinterest/oauth.service";
import { InvalidTransitionError } from "../modules/state/state-machine";
import { ensureUser } from "../modules/users/user.service";
import { PinterestApiError } from "../modules/pinterest/client";
import type { BotContext } from "./context";
import { registerCommands } from "./commands";
import { registerCallbacks } from "./handlers/callbacks";
import { registerText } from "./handlers/text";

/** Simple per-user token bucket: 30 actions/minute, bursts of 10. */
export function createRateLimiter(capacity = 10, refillPerSec = 0.5) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    buckets.set(key, b);
    return ok;
  };
}

export function userFacingError(e: unknown): string {
  if (e instanceof StaleActionError || e instanceof InvalidStateError || e instanceof NotFoundError || e instanceof ReconnectRequiredError) return e.message;
  if (e instanceof InvalidTransitionError) return "That action isn't possible in the pin's current state.";
  if (e instanceof PinterestApiError) {
    if (e.isPermission) return "Pinterest refused the request (permissions). Check your app's access level and scopes.";
    if (e.isRateLimit) return "Pinterest rate limit reached. Please try again in a few minutes.";
    return `Pinterest error (${e.status}). Please try again later.`;
  }
  return "Something went wrong. Please try again.";
}

export function createBot(token = env.TELEGRAM_BOT_TOKEN) {
  const bot = new Bot<BotContext>(token || "0:missing-token");
  const onError = async (err: BotError<BotContext>) => {
    const e = err.error;
    const expected = e instanceof StaleActionError || e instanceof InvalidStateError || e instanceof NotFoundError || e instanceof ReconnectRequiredError;
    if (expected) logger.info({ msg: errMessage(e) }, "User action rejected");
    else logger.error({ err: errMessage(e), update: err.ctx.update.update_id, stack: e instanceof Error ? e.stack : undefined }, "Bot handler error");
    if (e instanceof GrammyError && /message is not modified/.test(e.description)) return;
    try {
      if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery({ text: userFacingError(e).slice(0, 190), show_alert: true }).catch(() => undefined);
      await err.ctx.reply(`⚠️ ${userFacingError(e)}`);
    } catch {
      /* ignore */
    }
  };

  // Error boundary (not bot.catch): webhook updates must never fail, or Telegram redelivers them.
  const c = bot.errorBoundary(onError);
  bot.catch(onError);
  const limiter = createRateLimiter(Math.max(10, Math.ceil(env.BOT_RATE_LIMIT_PER_MINUTE / 3)), env.BOT_RATE_LIMIT_PER_MINUTE / 60);

  c.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    // Only private chats: keeps previews and controls out of groups.
    if (ctx.chat && ctx.chat.type !== "private") return;
    const user = await ensureUser(ctx.from, ctx.chat?.id ?? ctx.from.id);
    if (!user.isAuthorized) {
      logger.warn({ telegramUserId: ctx.from.id }, "Unauthorized Telegram user");
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => undefined);
      else await ctx.reply(`⛔ You're not authorized to use this bot.\nYour Telegram user ID is ${ctx.from.id}.`).catch(() => undefined);
      return;
    }
    if (!limiter(user.telegramUserId)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Slow down a little 🙂" }).catch(() => undefined);
      else await ctx.reply("You're sending requests too quickly. Please wait a moment.").catch(() => undefined);
      return;
    }
    ctx.user = user;
    await next();
  });

  registerCommands(c);
  registerCallbacks(c);
  registerText(c);
  c.on("message", (ctx) => ctx.reply("Send keywords as text, or see /help."));

  return bot;
}
