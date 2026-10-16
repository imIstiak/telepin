import http from "node:http";
import { closeDatabase } from "./config/database";
import { env, integrationStatus } from "./config/env";
import { logger } from "./config/logger";
import { reconcileSchedules } from "./modules/scheduling/reconciliation.service";
import { closeQueues, getQueues } from "./queues";
import { startWorkers } from "./workers";

async function main() {
  logger.info({ integrations: integrationStatus() }, "Starting worker");
  // Recover schedules BEFORE consuming the publish queue so a backlog is never published in a burst.
  await reconcileSchedules();
  const workers = startWorkers();
  const q = getQueues();
  await q.maintenance.upsertJobScheduler("reconcile-schedules", { every: 5 * 60_000 }, { name: "reconcile", data: { kind: "reconcile-schedules" } });
  await q.maintenance.upsertJobScheduler("cleanup-images", { every: 24 * 3600_000 }, { name: "cleanup", data: { kind: "cleanup-images" } });

  // Minimal health endpoint for Railway.
  const port = Number(process.env.WORKER_HEALTH_PORT ?? process.env.PORT ?? 0);
  const server = port
    ? http.createServer((req, res) => {
        const ok = workers.every((w) => w.isRunning());
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, service: "worker" }));
      }).listen(port)
    : null;

  logger.info({ queues: workers.map((w) => w.name), env: env.NODE_ENV }, "Workers running");

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "Shutting down worker gracefully");
    server?.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  logger.fatal({ err: e }, "Worker failed to start");
  process.exit(1);
});
