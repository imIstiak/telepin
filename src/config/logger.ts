import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: {
    paths: [
      "*.access_token",
      "*.refresh_token",
      "*.accessToken",
      "*.refreshToken",
      "*.authorization",
      "*.Authorization",
      "*.headers.authorization",
      "*.client_secret",
      "*.token",
      "*.apiKey",
      "*.secret",
      "req.headers['x-telegram-bot-api-secret-token']",
    ],
    censor: "[REDACTED]",
  },
  transport:
    env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } : undefined,
});

/** Removes secrets that may appear inside error strings (bot tokens in URLs, bearer tokens). */
export function redactString(s: string): string {
  let out = s.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  for (const secret of [env.TELEGRAM_BOT_TOKEN, env.PINTEREST_CLIENT_SECRET, env.AI_TEXT_API_KEY, env.AI_IMAGE_API_KEY, env.R2_SECRET_ACCESS_KEY]) {
    if (secret && secret.length > 6) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function errMessage(e: unknown): string {
  return redactString(e instanceof Error ? e.message : String(e)).slice(0, 1000);
}
