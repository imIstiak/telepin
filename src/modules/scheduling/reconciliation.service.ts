import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { imageAssets, pinDrafts, pinSchedules, publishJobs } from "../../db/schema";
import { getQueues, publishJobId } from "../../queues";
import { getStorage } from "../storage/r2.service";
import { enqueueSchedule, handleMissed } from "./schedule.service";

const STUCK_RUNNING_MS = 10 * 60_000;

/**
 * PostgreSQL is the source of truth. Ensures every SCHEDULED row has a matching BullMQ trigger,
 * applies the missed-schedule policy, and moves crashed in-flight publishes to PUBLISH_UNKNOWN.
 */
export async function reconcileSchedules() {
  const q = getQueues().publish;
  const graceMs = env.MISSED_SCHEDULE_GRACE_MINUTES * 60_000;
  const stats = { enqueued: 0, missedBatches: 0, stuck: 0, unknownRequeued: 0 };

  // 1) Missed schedules → policy per batch (never a burst).
  const scheduled = await db.select().from(pinSchedules).where(eq(pinSchedules.status, "SCHEDULED"));
  const missedBatches = new Set(scheduled.filter((s) => s.scheduledAt.getTime() < Date.now() - graceMs).map((s) => s.batchId));
  for (const b of missedBatches) {
    await handleMissed(b);
    stats.missedBatches++;
  }

  // 2) Re-create missing BullMQ triggers.
  const live = await db.select().from(pinSchedules).where(eq(pinSchedules.status, "SCHEDULED"));
  for (const s of live) {
    const job = await q.getJob(publishJobId(s.id, s.revision));
    const state = job ? await job.getState() : "missing";
    if (state === "missing" || state === "completed" || state === "failed" || state === "unknown") {
      if (job && (state === "completed" || state === "failed")) await job.remove().catch(() => undefined);
      await enqueueSchedule(s);
      stats.enqueued++;
    }
  }

  // 3) Publishes that were RUNNING when a worker died: outcome unknown → reconcile, never blind-retry.
  const stuck = await db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.status, "RUNNING"), lt(publishJobs.attemptStartedAt, new Date(Date.now() - STUCK_RUNNING_MS))));
  for (const j of stuck) {
    await db.transaction(async (tx) => {
      await tx.update(publishJobs).set({ status: "UNKNOWN", lastError: "Worker stopped during publishing", reconcileAttempts: 0 }).where(eq(publishJobs.id, j.id));
      await tx.update(pinSchedules).set({ status: "PUBLISH_UNKNOWN" }).where(eq(pinSchedules.id, j.scheduleId));
      await tx.update(pinDrafts).set({ status: "PUBLISH_UNKNOWN" }).where(eq(pinDrafts.id, j.draftId));
    });
    stats.stuck++;
  }

  // 4) Every UNKNOWN job must have a reconcile trigger.
  const unknown = await db.select().from(publishJobs).where(eq(publishJobs.status, "UNKNOWN"));
  for (const j of unknown) {
    const id = `reconcile-${j.id}-${j.reconcileAttempts + 1}`;
    const existing = await q.getJob(id);
    if (!existing || ["completed", "failed"].includes(await existing.getState())) {
      if (existing) await existing.remove().catch(() => undefined);
      await q.add("reconcile", { publishJobId: j.id }, { jobId: id, delay: 30_000 });
      stats.unknownRequeued++;
    }
  }
  if (Object.values(stats).some(Boolean)) logger.info(stats, "Schedule reconciliation");
  return stats;
}

/** Deletes old draft images that were never published and are no longer selected. Published images are kept. */
export async function cleanupDraftImages() {
  const cutoff = new Date(Date.now() - env.DRAFT_IMAGE_RETENTION_DAYS * 24 * 3600_000);
  const candidates = await db
    .select({ asset: imageAssets, draft: pinDrafts })
    .from(imageAssets)
    .innerJoin(pinDrafts, eq(pinDrafts.id, imageAssets.draftId))
    .where(and(isNull(imageAssets.deletedAt), lt(imageAssets.createdAt, cutoff)))
    .limit(500);
  let deleted = 0;
  for (const { asset, draft } of candidates) {
    const inUse = draft.selectedImageId === asset.id || draft.backgroundImageId === asset.id;
    // Images still referenced by a live or published pin are always kept.
    if (inUse && !["CANCELLED", "FAILED"].includes(draft.status)) continue;
    try {
      await getStorage().delete(asset.objectKey);
      await db.update(imageAssets).set({ deletedAt: new Date() }).where(eq(imageAssets.id, asset.id));
      deleted++;
    } catch (e) {
      logger.warn({ err: e, key: asset.objectKey }, "Image cleanup failed");
    }
  }
  if (deleted) logger.info({ deleted }, "Cleaned up unused draft images");
  return deleted;
}

