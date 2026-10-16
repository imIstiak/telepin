import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { webhookCallback, type Bot } from "grammy";
import { sql } from "drizzle-orm";
import { db } from "./config/database";
import { env, integrationStatus } from "./config/env";
import { errMessage, logger } from "./config/logger";
import { createRedisConnection } from "./config/redis";
import type { BotContext } from "./bot/context";
import { syncBoards } from "./modules/pinterest/boards.service";
import { consumeState, exchangeCodeAndStore, OAuthStateError } from "./modules/pinterest/oauth.service";
import { notifier } from "./modules/notifications/notifier";
import { escapeHtml } from "./utils/text";
import { timingSafeEqualStr } from "./utils/crypto";

/** Fixed-window IP rate limiter for public HTTP endpoints. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return void res.status(429).send("Too many requests");
    next();
  };
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;line-height:1.5;color:#222}h1{font-size:1.4rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;

export function createApp(bot: Bot<BotContext> | null) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  if (env.NODE_ENV === "production") {
    app.use((req, res, next) => {
      if (req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"] !== "https") return void res.status(400).send("HTTPS required");
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
      next();
    });
  }

  const redis = createRedisConnection({ maxRetriesPerRequest: 1, lazyConnect: true });
  app.get("/health", async (_req, res) => {
    const checks: Record<string, boolean> = { db: false, redis: false };
    try {
      await db.execute(sql`select 1`);
      checks.db = true;
    } catch {
      /* reported below */
    }
    try {
      checks.redis = (await redis.ping()) === "PONG";
    } catch {
      /* reported below */
    }
    const ok = checks.db && checks.redis;
    res.status(ok ? 200 : 503).json({ ok, checks, integrations: integrationStatus() });
  });

  if (bot) {
    const handle = webhookCallback(bot, "express", { secretToken: env.TELEGRAM_WEBHOOK_SECRET || undefined, onTimeout: "return", timeoutMilliseconds: 9_000 });
    app.post("/telegram/webhook", express.json({ limit: "1mb" }), (req, res, next) => {
      // grammY validates the secret too; this early check avoids parsing work for spoofed requests.
      const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
      if (env.TELEGRAM_WEBHOOK_SECRET && !timingSafeEqualStr(got, env.TELEGRAM_WEBHOOK_SECRET)) return void res.sendStatus(401);
      return handle(req, res).catch(next);
    });
  }

  app.get("/oauth/pinterest/callback", rateLimit(20, 60_000), async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (typeof req.query.error === "string") {
      return void res.status(400).send(page("Pinterest connection cancelled", "You can close this window and try /connect again in Telegram."));
    }
    let userId: string;
    try {
      userId = await consumeState(state);
    } catch (e) {
      const msg = e instanceof OAuthStateError ? "This link is invalid or expired. Send /connect in Telegram to get a new one." : "Unexpected error.";
      return void res.status(400).send(page("Connection failed", escapeHtml(msg)));
    }
    if (!code || code.length > 512) return void res.status(400).send(page("Connection failed", "Missing authorization code."));
    try {
      const acc = await exchangeCodeAndStore(userId, code);
      let boardCount = 0;
      try {
        boardCount = (await syncBoards(userId)).length;
      } catch (e) {
        logger.warn({ err: errMessage(e) }, "Initial board sync failed");
      }
      await notifier.text(userId, `✅ Pinterest connected${acc.username ? ` as <b>@${escapeHtml(acc.username)}</b>` : ""}. ${boardCount} board(s) synced. Use /boards to see them.`, { force: true });
      res.send(page("Pinterest connected ✅", "You can close this window and return to Telegram."));
    } catch (e) {
      logger.error({ err: errMessage(e) }, "Pinterest OAuth exchange failed");
      await notifier.text(userId, "❌ Pinterest connection failed. Please try /connect again.", { force: true });
      res.status(502).send(page("Connection failed", "Pinterest did not accept the authorization. Please try /connect again."));
    }
  });

  if (env.STORAGE_DRIVER === "local") {
    // Development only: serve locally stored images.
    app.use("/media", express.static(path.resolve(env.LOCAL_STORAGE_DIR), { fallthrough: false, index: false, dotfiles: "deny" }));
  }

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: errMessage(err) }, "HTTP error");
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}
