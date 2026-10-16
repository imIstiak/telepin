import { createApp } from "./app";
import { createBot } from "./bot/bot";
import { COMMANDS } from "./bot/commands";
import { closeDatabase } from "./config/database";
import { env, integrationStatus } from "./config/env";
import { errMessage, logger } from "./config/logger";
import { runMigrations } from "./db/migrate";
import { closeQueues } from "./queues";

async function main() {
  if (process.env.RUN_MIGRATIONS_ON_START === "true") await runMigrations();
  const status = integrationStatus();
  logger.info({ integrations: status }, "Starting API service");

  const bot = status.telegram ? createBot() : null;
  if (!bot) logger.warn("TELEGRAM_BOT_TOKEN missing — Telegram bot disabled");
  const app = createApp(bot);
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, "HTTP server listening"));

  if (bot) {
    await bot.init();
    await bot.api.setMyCommands(COMMANDS).catch((e) => logger.warn({ err: errMessage(e) }, "setMyCommands failed"));
    if (env.TELEGRAM_USE_POLLING) {
      await bot.api.deleteWebhook();
      void bot.start({ allowed_updates: ["message", "callback_query"], onStart: (me) => logger.info({ bot: me.username }, "Bot polling started") });
    } else {
      const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/telegram/webhook`;
      await bot.api.setWebhook(url, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      logger.info({ bot: bot.botInfo.username, url }, "Telegram webhook set");
    }
  }

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "Shutting down API");
    if (bot && env.TELEGRAM_USE_POLLING) await bot.stop();
    server.close();
    await closeQueues();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  logger.fatal({ err: errMessage(e) }, "API failed to start");
  process.exit(1);
});
