import { Queue, type JobsOptions } from "bullmq";
import { createRedisConnection } from "../config/redis";

export const QUEUES = {
  content: "content-generation",
  background: "background-generation",
  render: "image-rendering",
  publish: "pinterest-publishing",
  maintenance: "maintenance",
} as const;

export type ContentJob = { kind: "batch"; batchId: string } | { kind: "rewrite"; draftId: string; version: number; thenBackground: boolean };
export type BackgroundJob = { draftId: string; version: number; notify: "batch" | "draft" };
export type RenderJob = { draftId: string; version: number; notify: "batch" | "draft" };
export type PublishJobData = { scheduleId: string; revision: number };
export type ReconcileJobData = { publishJobId: string };
export type MaintenanceJob = { kind: "cleanup-images" } | { kind: "reconcile-schedules" };

const retrying: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

let queues:
  | {
      content: Queue<ContentJob>;
      background: Queue<BackgroundJob>;
      render: Queue<RenderJob>;
      publish: Queue<PublishJobData | ReconcileJobData>;
      maintenance: Queue<MaintenanceJob>;
    }
  | undefined;

export function getQueues() {
  if (!queues) {
    const connection = createRedisConnection();
    queues = {
      content: new Queue(QUEUES.content, { connection, defaultJobOptions: retrying }),
      background: new Queue(QUEUES.background, { connection, defaultJobOptions: retrying }),
      render: new Queue(QUEUES.render, { connection, defaultJobOptions: retrying }),
      // Publishing retries are controlled by our own state machine (to avoid duplicate pins), not BullMQ.
      publish: new Queue(QUEUES.publish, {
        connection,
        defaultJobOptions: { attempts: 1, removeOnComplete: { age: 30 * 24 * 3600 }, removeOnFail: { age: 30 * 24 * 3600 } },
      }),
      maintenance: new Queue(QUEUES.maintenance, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } }),
    };
  }
  return queues;
}

export function publishJobId(scheduleId: string, revision: number) {
  return `publish-${scheduleId}-r${revision}`;
}

export async function closeQueues() {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((q) => q.close()));
  queues = undefined;
}
