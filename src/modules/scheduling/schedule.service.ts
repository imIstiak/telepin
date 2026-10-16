import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../../config/database";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  pinBatches,
  pinDrafts,
  pinSchedules,
  pinterestBoards,
  publishJobs,
  type PinBatch,
  type PinDraft,
  type PinSchedule,
  type SchedulePlan,
} from "../../db/schema";
import { getQueues, publishJobId } from "../../queues";
import { audit } from "../audit/audit.service";
import { getOwnedBatch, refreshBatchStatus } from "../batches/batch.service";
import { getFinalImage, InvalidStateError, listBatchDrafts, StaleActionError } from "../batches/draft.service";
import { getOwnedBoard } from "../pinterest/boards.service";
import { getUser } from "../users/user.service";
import { buildTimeline } from "../../utils/time";

export const ACTIVE_SCHEDULE_STATES = ["SCHEDULED", "PAUSED", "PUBLISHING", "PUBLISH_UNKNOWN"] as const;

/** Pins in a batch that would be included in a schedule, plus reasons others are excluded/blocking. */
export async function schedulableDrafts(batchId: string) {
  const drafts = await listBatchDrafts(batchId);
  const include: PinDraft[] = [];
  const blocking: string[] = [];
  const skipped: string[] = [];
  for (const d of drafts) {
    if (d.status === "CANCELLED" || d.approvalStatus === "REJECTED") continue;
    if (["SCHEDULED", "PUBLISHING", "PUBLISHED", "PUBLISH_UNKNOWN"].includes(d.status)) continue;
    if (d.status === "FAILED" && !(d.selectedImageId && d.quote)) {
      skipped.push(`Pin ${d.position} failed to generate and will be skipped`);
      continue;
    }
    if (d.status === "GENERATING" || d.status === "CREATED") blocking.push(`Pin ${d.position} is still generating`);
    else if (!d.selectedImageId) blocking.push(`Pin ${d.position} has no image`);
    else if (!d.selectedBoardId) blocking.push(`Pin ${d.position} has no board assigned`);
    else if (d.status !== "APPROVED" && (await getFinalImage(d))?.isFallback)
      skipped.push(`Pin ${d.position} uses a fallback background and will be skipped — regenerate it, or approve it individually first`);
    else include.push(d);
  }
  return { include, blocking, skipped };
}

/** Stores a proposed plan on the batch. Nothing is scheduled until confirmPlan(). */
export async function proposePlan(userId: string, batchId: string, startAt: Date, intervalMinutes: number): Promise<{ batch: PinBatch; drafts: PinDraft[]; skipped: string[] }> {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 7 * 24 * 60) throw new InvalidStateError("Invalid interval.");
  const batch = await getOwnedBatch(userId, batchId);
  if (["CANCELLED", "COMPLETED"].includes(batch.status)) throw new InvalidStateError(`Batch is ${batch.status.toLowerCase()}.`);
  const { include, blocking, skipped } = await schedulableDrafts(batchId);
  if (blocking.length) throw new InvalidStateError(`Can't schedule yet:\n• ${blocking.join("\n• ")}`);
  if (include.length === 0) throw new InvalidStateError("There are no pins to schedule in this batch.");
  const user = await getUser(userId);
  const now = Date.now();
  const start = startAt.getTime() < now ? new Date(now) : startAt;
  const plan: SchedulePlan = {
    startAt: start.toISOString(),
    intervalMinutes,
    timezone: user?.timezone ?? env.DEFAULT_TIMEZONE,
    draftVersions: Object.fromEntries(include.map((d) => [d.id, d.version])),
    proposedAt: new Date().toISOString(),
  };
  const [b] = await db.update(pinBatches).set({ schedulePlan: plan }).where(eq(pinBatches.id, batchId)).returning();
  return { batch: b!, drafts: include, skipped };
}

export async function clearPlan(userId: string, batchId: string) {
  await getOwnedBatch(userId, batchId);
  await db.update(pinBatches).set({ schedulePlan: null }).where(eq(pinBatches.id, batchId));
}

async function enqueue(s: Pick<PinSchedule, "id" | "revision" | "scheduledAt">) {
  const delay = Math.max(0, s.scheduledAt.getTime() - Date.now());
  await getQueues().publish.add("publish", { scheduleId: s.id, revision: s.revision }, { jobId: publishJobId(s.id, s.revision), delay });
}

async function removeQueued(s: Pick<PinSchedule, "id" | "revision">) {
  try {
    const job = await getQueues().publish.getJob(publishJobId(s.id, s.revision));
    if (job && !(await job.isActive())) await job.remove();
  } catch (e) {
    logger.warn({ err: e, scheduleId: s.id }, "Could not remove queued publish job (revision guard will ignore it)");
  }
}

/**
 * The explicit final approval. Atomically approves exactly the pin versions that were shown in the review,
 * creates durable schedules + publish job records, then enqueues delayed BullMQ triggers.
 */
export async function confirmPlan(userId: string, batchId: string): Promise<PinSchedule[]> {
  const created = await db.transaction(async (tx) => {
    const [batch] = await tx.select().from(pinBatches).where(and(eq(pinBatches.id, batchId), eq(pinBatches.userId, userId))).for("update");
    if (!batch) throw new InvalidStateError("Batch not found.");
    const plan = batch.schedulePlan;
    if (!plan) throw new StaleActionError("This schedule was already confirmed or cancelled.");
    const ids = Object.keys(plan.draftVersions);
    const drafts = await tx.select().from(pinDrafts).where(inArray(pinDrafts.id, ids)).orderBy(asc(pinDrafts.position)).for("update");
    if (drafts.length !== ids.length) throw new StaleActionError("Pins changed since the review. Please review again.");
    for (const d of drafts) {
      if (d.version !== plan.draftVersions[d.id]) throw new StaleActionError(`Pin ${d.position} changed after the review. Please review the schedule again.`);
      // FAILED pins that already have an image (e.g. a failed publish) can be scheduled again.
      if (!["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED"].includes(d.status) || !d.selectedImageId || !d.selectedBoardId) {
        throw new StaleActionError(`Pin ${d.position} is no longer ready. Please review again.`);
      }
      const board = await getOwnedBoard(userId, d.selectedBoardId);
      if (!board) throw new InvalidStateError(`The board for pin ${d.position} is no longer available. Change its board.`);
    }
    const start = new Date(Math.max(Date.parse(plan.startAt), Date.now()));
    const times = buildTimeline(start, drafts.length, plan.intervalMinutes);
    const out: PinSchedule[] = [];
    for (const [i, d] of drafts.entries()) {
      await tx
        .update(pinDrafts)
        .set({ status: "SCHEDULED", approvalStatus: "APPROVED", approvedVersion: d.version })
        .where(eq(pinDrafts.id, d.id));
      const [s] = await tx
        .insert(pinSchedules)
        .values({
          draftId: d.id,
          batchId,
          userId,
          boardId: d.selectedBoardId!,
          scheduledAt: times[i]!,
          timezone: plan.timezone,
          intervalMinutes: plan.intervalMinutes,
          approvedVersion: d.version,
        })
        .returning();
      await tx.insert(publishJobs).values({ draftId: d.id, scheduleId: s!.id, idempotencyKey: `${d.id}:v${d.version}:${s!.id}` });
      out.push(s!);
    }
    await tx.update(pinBatches).set({ schedulePlan: null, status: "SCHEDULED" }).where(eq(pinBatches.id, batchId));
    await audit({ userId, batchId, action: "batch.schedule_confirmed", details: { pins: drafts.map((d) => ({ id: d.id, v: d.version })), start: start.toISOString(), interval: plan.intervalMinutes } }, tx);
    return out;
  });
  for (const s of created) {
    try {
      await enqueue(s);
    } catch (e) {
      // PostgreSQL is the source of truth; reconciliation will enqueue it.
      logger.error({ err: e, scheduleId: s.id }, "Failed to enqueue publish job; reconciliation will retry");
    }
  }
  return created;
}

async function lockActiveSchedules(tx: Tx, userId: string, batchId: string, states: PinSchedule["status"][]) {
  return tx
    .select()
    .from(pinSchedules)
    .where(and(eq(pinSchedules.batchId, batchId), eq(pinSchedules.userId, userId), inArray(pinSchedules.status, states)))
    .orderBy(asc(pinSchedules.scheduledAt))
    .for("update");
}

export async function pauseBatch(userId: string, batchId: string): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    const rows = await lockActiveSchedules(tx, userId, batchId, ["SCHEDULED"]);
    if (rows.length) await tx.update(pinSchedules).set({ status: "PAUSED" }).where(inArray(pinSchedules.id, rows.map((r) => r.id)));
    await audit({ userId, batchId, action: "schedule.paused", details: { count: rows.length } }, tx);
    return rows;
  });
  for (const r of rows) await removeQueued(r);
  return rows.length;
}

/** Re-times schedules (in their current order) from `start`, spaced by their interval, with a new revision. */
async function retime(tx: Tx, rows: PinSchedule[], start: Date, status: "SCHEDULED" | "PAUSED" = "SCHEDULED") {
  const out: PinSchedule[] = [];
  for (const [i, r] of rows.entries()) {
    const at = new Date(start.getTime() + i * r.intervalMinutes * 60_000);
    const [u] = await tx
      .update(pinSchedules)
      .set({ scheduledAt: at, status, revision: r.revision + 1 })
      .where(eq(pinSchedules.id, r.id))
      .returning();
    out.push(u!);
  }
  return out;
}

export async function resumeBatch(userId: string, batchId: string): Promise<PinSchedule[]> {
  const updated = await db.transaction(async (tx) => {
    const rows = await lockActiveSchedules(tx, userId, batchId, ["PAUSED"]);
    if (!rows.length) return [];
    const soon = Date.now() + 60_000;
    let res: PinSchedule[];
    if (rows[0]!.scheduledAt.getTime() >= soon) {
      // All original times are still ahead: keep them exactly.
      res = [];
      for (const r of rows) {
        const [u] = await tx.update(pinSchedules).set({ status: "SCHEDULED", revision: r.revision + 1 }).where(eq(pinSchedules.id, r.id)).returning();
        res.push(u!);
      }
    } else {
      // Some times passed while paused: continue the sequence from now with the same spacing.
      res = await retime(tx, rows, new Date(soon));
    }
    await audit({ userId, batchId, action: "schedule.resumed", details: { count: rows.length } }, tx);
    return res;
  });
  for (const s of updated) await enqueue(s);
  return updated;
}

export async function rescheduleBatch(userId: string, batchId: string, newStart: Date): Promise<PinSchedule[]> {
  if (newStart.getTime() < Date.now() - 60_000) throw new InvalidStateError("The new start time is in the past.");
  const { old, updated } = await db.transaction(async (tx) => {
    const rows = await lockActiveSchedules(tx, userId, batchId, ["SCHEDULED", "PAUSED"]);
    if (!rows.length) throw new InvalidStateError("There are no pending schedules in this batch.");
    const updated = await retime(tx, rows, newStart);
    await audit({ userId, batchId, action: "schedule.rescheduled", details: { start: newStart.toISOString(), count: rows.length } }, tx);
    return { old: rows, updated };
  });
  for (const r of old) await removeQueued(r);
  for (const s of updated) await enqueue(s);
  return updated;
}

/** Cancels pending schedules; pins return to APPROVED (content approval is kept). */
export async function cancelBatchSchedules(userId: string, batchId: string): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    const rows = await lockActiveSchedules(tx, userId, batchId, ["SCHEDULED", "PAUSED"]);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await tx.update(pinSchedules).set({ status: "CANCELLED" }).where(inArray(pinSchedules.id, ids));
    await tx.update(publishJobs).set({ status: "CANCELLED" }).where(and(inArray(publishJobs.scheduleId, ids), eq(publishJobs.status, "QUEUED")));
    await tx
      .update(pinDrafts)
      .set({ status: "APPROVED" })
      .where(and(inArray(pinDrafts.id, rows.map((r) => r.draftId)), eq(pinDrafts.status, "SCHEDULED")));
    await audit({ userId, batchId, action: "schedule.cancelled", details: { count: rows.length } }, tx);
    return rows;
  });
  for (const r of rows) await removeQueued(r);
  if (rows.length) await refreshBatchStatus(batchId);
  return rows.length;
}

/**
 * Applies MISSED_SCHEDULE_POLICY to overdue schedules of a batch (called from recovery and from the
 * publish worker when a delayed job fires far too late). Never publishes a backlog in a burst.
 */
export async function handleMissed(batchId: string): Promise<{ policy: string; count: number }> {
  const graceMs = env.MISSED_SCHEDULE_GRACE_MINUTES * 60_000;
  const result = await db.transaction(async (tx) => {
    const [batch] = await tx.select().from(pinBatches).where(eq(pinBatches.id, batchId)).for("update");
    if (!batch) return { rows: [] as PinSchedule[], updated: [] as PinSchedule[], userId: "" };
    const rows = await lockActiveSchedules(tx, batch.userId, batchId, ["SCHEDULED"]);
    const missed = rows.filter((r) => r.scheduledAt.getTime() < Date.now() - graceMs);
    if (!missed.length) return { rows: [], updated: [], userId: batch.userId };
    let updated: PinSchedule[];
    if (env.MISSED_SCHEDULE_POLICY === "pause") {
      updated = await retime(tx, rows, rows[0]!.scheduledAt, "PAUSED");
    } else {
      // shift: keep order and spacing; the first pending pin goes out ~1 minute from now.
      updated = await retime(tx, rows, new Date(Date.now() + 60_000));
    }
    await audit({ userId: batch.userId, batchId, action: "schedule.missed", details: { policy: env.MISSED_SCHEDULE_POLICY, missed: missed.length } }, tx);
    return { rows, updated, userId: batch.userId };
  });
  if (!result.updated.length) return { policy: env.MISSED_SCHEDULE_POLICY, count: 0 };
  for (const r of result.rows) await removeQueued(r);
  if (env.MISSED_SCHEDULE_POLICY === "shift") for (const s of result.updated) await enqueue(s);
  const { notifier } = await import("../notifications/notifier");
  await notifier.text(
    result.userId,
    env.MISSED_SCHEDULE_POLICY === "shift"
      ? `⏱ Some scheduled pins were missed while the service was offline. The remaining ${result.updated.length} pin(s) were shifted to continue from now with the same spacing. See /queue.`
      : `⏸ Some scheduled pins were missed while the service was offline. ${result.updated.length} pin(s) are paused — use /queue to resume or reschedule.`,
    { force: true },
  );
  return { policy: env.MISSED_SCHEDULE_POLICY, count: result.updated.length };
}

export async function upcomingQueue(userId: string) {
  return db
    .select({ schedule: pinSchedules, draft: pinDrafts, boardName: pinterestBoards.name, batchNumber: pinBatches.number })
    .from(pinSchedules)
    .innerJoin(pinDrafts, eq(pinDrafts.id, pinSchedules.draftId))
    .innerJoin(pinterestBoards, eq(pinterestBoards.id, pinSchedules.boardId))
    .innerJoin(pinBatches, eq(pinBatches.id, pinSchedules.batchId))
    .where(and(eq(pinSchedules.userId, userId), inArray(pinSchedules.status, [...ACTIVE_SCHEDULE_STATES])))
    .orderBy(asc(pinSchedules.scheduledAt))
    .limit(50);
}

export async function publishHistory(userId: string, limit = 20) {
  return db
    .select({ job: publishJobs, draft: pinDrafts, boardName: pinterestBoards.name, publishedAt: pinSchedules.publishedAt })
    .from(publishJobs)
    .innerJoin(pinSchedules, eq(pinSchedules.id, publishJobs.scheduleId))
    .innerJoin(pinDrafts, eq(pinDrafts.id, publishJobs.draftId))
    .innerJoin(pinterestBoards, eq(pinterestBoards.id, pinSchedules.boardId))
    .where(and(eq(pinSchedules.userId, userId), eq(publishJobs.status, "SUCCEEDED")))
    .orderBy(desc(pinSchedules.publishedAt))
    .limit(limit);
}

export { enqueue as enqueueSchedule, removeQueued };
