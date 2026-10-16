import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../config/env";
import { errMessage, logger } from "../config/logger";
import { createRedisConnection } from "../config/redis";
import { AIOutputError, AIProviderError } from "../modules/ai/provider.interface";
import {
  markBatchContentFailed,
  markDraftFailed,
  runBackground,
  runBatchContent,
  runRender,
  runRewrite,
} from "../modules/generation/pipeline.service";
import { TextOverflowError } from "../modules/images/typography.service";
import { publishSchedule, reconcileUnknown } from "../modules/publishing/publishing.service";
import { cleanupDraftImages, reconcileSchedules } from "../modules/scheduling/reconciliation.service";
import {
  QUEUES,
  type BackgroundJob,
  type ContentJob,
  type MaintenanceJob,
  type PublishJobData,
  type ReconcileJobData,
  type RenderJob,
} from "../queues";

const isFinal = (job: Job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
const isPermanent = (e: unknown) => (e instanceof AIProviderError && !e.retryable) || e instanceof TextOverflowError;

/** Turn known permanent errors into UnrecoverableError so BullMQ doesn't waste retries. */
function rethrow(e: unknown): never {
  if (e instanceof AIProviderError && !e.retryable) throw new UnrecoverableError(e.message);
  if (e instanceof TextOverflowError) throw new UnrecoverableError("The quote is too long to fit the image. Edit it to be shorter.");
  if (e instanceof AIOutputError) throw e; // retry: models are non-deterministic
  throw e;
}

export function startWorkers() {
  const base = { connection: createRedisConnection(), autorun: true };

  const content = new Worker<ContentJob>(
    QUEUES.content,
    async (job) => {
      try {
        if (job.data.kind === "batch") await runBatchContent(job.data.batchId);
        else await runRewrite(job.data.draftId, job.data.version, job.data.thenBackground);
      } catch (e) {
        if (isFinal(job) || isPermanent(e)) {
          if (job.data.kind === "batch") await markBatchContentFailed(job.data.batchId, e);
          else await markDraftFailed(job.data.draftId, job.data.version, e, "draft");
        }
        rethrow(e);
      }
    },
    { ...base, concurrency: env.GENERATION_CONCURRENCY, lockDuration: 120_000 },
  );

  const background = new Worker<BackgroundJob>(
    QUEUES.background,
    async (job) => {
      try {
        await runBackground(job.data, isFinal(job));
      } catch (e) {
        if (isFinal(job)) await markDraftFailed(job.data.draftId, job.data.version, e, job.data.notify);
        // (background falls back to a procedural image on the final attempt, so this is rare)
        rethrow(e);
      }
    },
    // Bounded concurrency so a 7-pin batch doesn't fire 7 expensive image requests at once.
    { ...base, connection: createRedisConnection(), concurrency: env.IMAGE_CONCURRENCY, lockDuration: 180_000 },
  );

  const render = new Worker<RenderJob>(
    QUEUES.render,
    async (job) => {
      try {
        await runRender(job.data);
      } catch (e) {
        if (isFinal(job) || e instanceof TextOverflowError) await markDraftFailed(job.data.draftId, job.data.version, e instanceof TextOverflowError ? new Error("The quote is too long to fit the image. Edit it to be shorter.") : e, job.data.notify);
        rethrow(e);
      }
    },
    { ...base, connection: createRedisConnection(), concurrency: env.IMAGE_CONCURRENCY },
  );

  const publish = new Worker<PublishJobData | ReconcileJobData>(
    QUEUES.publish,
    async (job) => {
      if (job.name === "reconcile") return reconcileUnknown((job.data as ReconcileJobData).publishJobId);
      const d = job.data as PublishJobData;
      return publishSchedule(d.scheduleId, d.revision);
    },
    { ...base, connection: createRedisConnection(), concurrency: env.PUBLISH_CONCURRENCY, lockDuration: 120_000 },
  );

  const maintenance = new Worker<MaintenanceJob>(
    QUEUES.maintenance,
    async (job) => {
      if (job.data.kind === "reconcile-schedules") return reconcileSchedules();
      return cleanupDraftImages();
    },
    { ...base, connection: createRedisConnection(), concurrency: 1 },
  );

  const all = [content, background, render, publish, maintenance];
  for (const w of all) {
    w.on("failed", (job, err) => logger.warn({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: errMessage(err) }, "Job failed"));
    w.on("error", (err) => logger.error({ queue: w.name, err: errMessage(err) }, "Worker error"));
  }
  return all;
}
