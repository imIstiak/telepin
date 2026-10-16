import { and, eq } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { errMessage, logger } from "../../config/logger";
import { imageAssets, pinBatches, pinDrafts, pinSchedules, pinterestBoards, publishJobs, type PinDraft, type PinSchedule, type PublishJob } from "../../db/schema";
import { getQueues, publishJobId } from "../../queues";
import { audit } from "../audit/audit.service";
import { refreshBatchStatus } from "../batches/batch.service";
import { notifier } from "../notifications/notifier";
import { PinterestApiError, PinterestUnknownOutcomeError } from "../pinterest/client";
import { getValidAccessToken, ReconnectRequiredError } from "../pinterest/oauth.service";
import { createPin, findMatchingRecentPin, type CreatedPin } from "../pinterest/pins.service";
import { handleMissed } from "../scheduling/schedule.service";
import { escapeHtml } from "../../utils/text";

export const RECONCILE_MAX_ATTEMPTS = 3;
export const RECONCILE_BASE_DELAY_MS = 2 * 60_000;

type Claimed = { schedule: PinSchedule; job: PublishJob; draft: PinDraft };

/** Atomically claims a schedule for publishing. Returns null if it must not be published now. */
async function claim(scheduleId: string, revision: number): Promise<Claimed | "missed" | null> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(pinSchedules).where(eq(pinSchedules.id, scheduleId)).for("update");
    if (!s || s.revision !== revision || s.status !== "SCHEDULED") return null; // stale trigger or already handled
    if (s.scheduledAt.getTime() < Date.now() - env.MISSED_SCHEDULE_GRACE_MINUTES * 60_000) return "missed";
    if (s.scheduledAt.getTime() > Date.now() + 5_000) return null; // fired early (shouldn't happen); reconciliation will re-enqueue
    const [job] = await tx.select().from(publishJobs).where(eq(publishJobs.scheduleId, s.id)).for("update");
    const [draft] = await tx.select().from(pinDrafts).where(eq(pinDrafts.id, s.draftId)).for("update");
    if (!job || !draft || job.status !== "QUEUED") return null;
    // Content must be exactly what the user approved.
    if (draft.status !== "SCHEDULED" || draft.version !== s.approvedVersion || draft.approvedVersion !== s.approvedVersion || draft.selectedBoardId !== s.boardId) {
      await tx.update(pinSchedules).set({ status: "FAILED" }).where(eq(pinSchedules.id, s.id));
      await tx.update(publishJobs).set({ status: "FAILED", lastError: "Content or board changed after approval" }).where(eq(publishJobs.id, job.id));
      await audit({ userId: s.userId, draftId: draft.id, action: "publish.blocked_unapproved_change" }, tx);
      return null;
    }
    const now = new Date();
    const [j] = await tx
      .update(publishJobs)
      .set({ status: "RUNNING", attemptCount: job.attemptCount + 1, attemptStartedAt: now, lastError: null })
      .where(and(eq(publishJobs.id, job.id), eq(publishJobs.status, "QUEUED")))
      .returning();
    if (!j) return null;
    const [s2] = await tx.update(pinSchedules).set({ status: "PUBLISHING" }).where(eq(pinSchedules.id, s.id)).returning();
    const [d2] = await tx.update(pinDrafts).set({ status: "PUBLISHING" }).where(eq(pinDrafts.id, draft.id)).returning();
    return { schedule: s2!, job: j, draft: d2! };
  });
}

async function markSucceeded(c: Claimed, pin: CreatedPin, via: string) {
  await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "SUCCEEDED", pinterestPinId: pin.id, pinterestPinUrl: pin.url, lastError: null }).where(eq(publishJobs.id, c.job.id));
    await tx.update(pinSchedules).set({ status: "PUBLISHED", publishedAt: new Date() }).where(eq(pinSchedules.id, c.schedule.id));
    await tx.update(pinDrafts).set({ status: "PUBLISHED" }).where(eq(pinDrafts.id, c.draft.id));
    await audit({ userId: c.schedule.userId, draftId: c.draft.id, batchId: c.schedule.batchId, action: "publish.succeeded", details: { pinId: pin.id, via } }, tx);
  });
  const board = await db.query.pinterestBoards.findFirst({ where: eq(pinterestBoards.id, c.schedule.boardId) });
  const { batch } = await refreshBatchStatus(c.schedule.batchId);
  await notifier.published(c.schedule.userId, {
    position: c.draft.position,
    batchNumber: batch.number,
    batchId: batch.id,
    boardName: board?.name ?? "?",
    pinUrl: pin.url,
    title: c.draft.title ?? "",
  });
  if (batch.status === "COMPLETED") await notifier.text(batch.userId, `🏁 Batch #${batch.number} is complete — all pins published. See /history.`);
}

async function markFailed(c: Claimed, reason: string) {
  await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "FAILED", lastError: reason }).where(eq(publishJobs.id, c.job.id));
    await tx.update(pinSchedules).set({ status: "FAILED" }).where(eq(pinSchedules.id, c.schedule.id));
    await tx.update(pinDrafts).set({ status: "FAILED", lastError: reason }).where(eq(pinDrafts.id, c.draft.id));
    await audit({ userId: c.schedule.userId, draftId: c.draft.id, action: "publish.failed", details: { reason } }, tx);
  });
  await refreshBatchStatus(c.schedule.batchId);
  await notifier.text(c.schedule.userId, `❌ <b>Pin ${c.draft.position} failed to publish.</b>\n${escapeHtml(reason)}\n\nYou can fix it and schedule it again from the batch.`, { force: true });
}

/** Put the claim back into the queue for a later retry (only used when we KNOW nothing was created). */
async function requeue(c: Claimed, delayMs: number, reason: string, opts: { pause?: boolean } = {}) {
  const at = new Date(Date.now() + delayMs);
  const [s] = await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "QUEUED", lastError: reason }).where(eq(publishJobs.id, c.job.id));
    await tx.update(pinDrafts).set({ status: "SCHEDULED" }).where(eq(pinDrafts.id, c.draft.id));
    return tx
      .update(pinSchedules)
      .set({ status: opts.pause ? "PAUSED" : "SCHEDULED", scheduledAt: at, revision: c.schedule.revision + 1 })
      .where(eq(pinSchedules.id, c.schedule.id))
      .returning();
  });
  if (!opts.pause) await getQueues().publish.add("publish", { scheduleId: s!.id, revision: s!.revision }, { jobId: publishJobId(s!.id, s!.revision), delay: delayMs });
}

async function markUnknown(c: Claimed, reason: string) {
  await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "UNKNOWN", lastError: reason, reconcileAttempts: 0 }).where(eq(publishJobs.id, c.job.id));
    await tx.update(pinSchedules).set({ status: "PUBLISH_UNKNOWN" }).where(eq(pinSchedules.id, c.schedule.id));
    await tx.update(pinDrafts).set({ status: "PUBLISH_UNKNOWN" }).where(eq(pinDrafts.id, c.draft.id));
    await audit({ userId: c.schedule.userId, draftId: c.draft.id, action: "publish.unknown", details: { reason } }, tx);
  });
  await getQueues().publish.add("reconcile", { publishJobId: c.job.id }, { jobId: `reconcile-${c.job.id}-1`, delay: 60_000 });
  await notifier.text(c.schedule.userId, `⏳ Pinterest didn't confirm pin ${c.draft.position} in time. I'm checking whether it was created before retrying (no duplicate will be posted).`, { force: true });
}

async function finalImageUrl(d: PinDraft): Promise<string> {
  if (!d.selectedImageId) throw new Error("Pin has no final image");
  const a = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, d.selectedImageId) });
  if (!a) throw new Error("Final image asset missing");
  if (!a.publicUrl.startsWith("https://")) throw new Error("Image URL is not publicly reachable over HTTPS (configure Cloudflare R2 with a public domain)");
  return a.publicUrl;
}

export async function publishSchedule(scheduleId: string, revision: number): Promise<"published" | "skipped" | "missed" | "requeued" | "unknown" | "failed"> {
  const c = await claim(scheduleId, revision);
  if (c === null) return "skipped";
  if (c === "missed") {
    const s = await db.query.pinSchedules.findFirst({ where: eq(pinSchedules.id, scheduleId) });
    if (s) await handleMissed(s.batchId);
    return "missed";
  }

  let token: string;
  try {
    token = (await getValidAccessToken(c.schedule.userId)).token;
  } catch (e) {
    if (e instanceof ReconnectRequiredError) {
      await requeue(c, 0, e.message, { pause: true });
      await notifier.text(c.schedule.userId, `🔌 ${escapeHtml(e.message)}\nPin ${c.draft.position} is paused. After reconnecting, use /queue → Resume.`, { force: true });
      return "requeued";
    }
    await requeue(c, 60_000, errMessage(e));
    return "requeued";
  }

  const board = await db.query.pinterestBoards.findFirst({ where: eq(pinterestBoards.id, c.schedule.boardId) });
  if (!board || !board.isActive) {
    await markFailed(c, "The selected board is no longer available on your Pinterest account.");
    return "failed";
  }
  let imageUrl: string;
  try {
    imageUrl = await finalImageUrl(c.draft);
  } catch (e) {
    await markFailed(c, errMessage(e));
    return "failed";
  }

  const input = {
    boardExternalId: board.externalBoardId,
    title: c.draft.title ?? "",
    description: c.draft.description ?? "",
    altText: c.draft.altText ?? "",
    link: c.draft.link,
    imageUrl,
  };

  for (let authRetry = 0; ; authRetry++) {
    try {
      const pin = await createPin({ accessToken: token, ...input });
      await markSucceeded(c, pin, "create");
      return "published";
    } catch (e) {
      if (e instanceof PinterestUnknownOutcomeError) {
        await markUnknown(c, errMessage(e));
        return "unknown";
      }
      if (e instanceof PinterestApiError) {
        // Missing OAuth scopes: a fresh token won't help — pause and ask the user to reconnect.
        if ((e.isAuth || e.isPermission) && /scope|sufficient permissions/i.test(e.message)) {
          await requeue(c, 0, e.message, { pause: true });
          await notifier.text(
            c.schedule.userId,
            `🔌 Pinterest needs extra permissions to publish (${escapeHtml(e.message.slice(0, 160))}).\nSend /connect, approve again, then /resume — pin ${c.draft.position} and the rest of the queue are paused, not lost.`,
            { force: true },
          );
          return "requeued";
        }
        if (e.isAuth && authRetry === 0) {
          try {
            token = (await getValidAccessToken(c.schedule.userId, { forceRefresh: true })).token;
            continue; // 401 means nothing was created, safe to retry once with a fresh token
          } catch (re) {
            await requeue(c, 0, errMessage(re), { pause: true });
            await notifier.text(c.schedule.userId, `🔌 Pinterest authorization failed. Reconnect with /connect, then resume from /queue.`, { force: true });
            return "requeued";
          }
        }
        if (e.isRetryable || e.status === 0) {
          if (c.job.attemptCount >= env.PUBLISH_MAX_ATTEMPTS) {
            await markFailed(c, `Pinterest kept failing after ${c.job.attemptCount} attempts: ${e.message}`);
            return "failed";
          }
          const delay = Math.min((e.retryAfterSec ?? 60 * 2 ** (c.job.attemptCount - 1)) * 1000, 60 * 60_000);
          logger.warn({ scheduleId, status: e.status, delay }, "Pinterest rejected publish transiently; requeueing");
          await requeue(c, delay, e.message);
          return "requeued";
        }
        const hint = e.isPermission ? " (check that your Pinterest app has pins:write access and Standard access for production publishing)" : "";
        await markFailed(c, `Pinterest error ${e.status}: ${e.message}${hint}`);
        return "failed";
      }
      // Unexpected local error before/while sending: we can't be sure the request didn't go out.
      await markUnknown(c, errMessage(e));
      return "unknown";
    }
  }
}

/** Resolves a PUBLISH_UNKNOWN outcome by looking for the pin on the board before ever retrying. */
export async function reconcileUnknown(publishJobIdArg: string): Promise<"found" | "retry_scheduled" | "waiting" | "failed" | "skipped"> {
  const job = await db.query.publishJobs.findFirst({ where: eq(publishJobs.id, publishJobIdArg) });
  if (!job || job.status !== "UNKNOWN") return "skipped";
  const schedule = await db.query.pinSchedules.findFirst({ where: eq(pinSchedules.id, job.scheduleId) });
  const draft = await db.query.pinDrafts.findFirst({ where: eq(pinDrafts.id, job.draftId) });
  const board = schedule && (await db.query.pinterestBoards.findFirst({ where: eq(pinterestBoards.id, schedule.boardId) }));
  if (!schedule || !draft || !board) return "skipped";
  const c: Claimed = { schedule, job, draft };
  const attempts = job.reconcileAttempts + 1;
  await db.update(publishJobs).set({ reconcileAttempts: attempts }).where(eq(publishJobs.id, job.id));

  try {
    const { token } = await getValidAccessToken(schedule.userId);
    // Pins we already know about (published by this app) can never be the match.
    const known = await db.select({ id: publishJobs.pinterestPinId }).from(publishJobs).where(eq(publishJobs.status, "SUCCEEDED"));
    const found = await findMatchingRecentPin(token, board.externalBoardId, {
      title: draft.title ?? "",
      description: draft.description ?? "",
      altText: draft.altText,
      since: job.attemptStartedAt ?? job.createdAt,
      excludePinIds: known.map((k) => k.id).filter((x): x is string => Boolean(x)),
    });
    if (found) {
      await markSucceeded(c, found, "reconciliation");
      return "found";
    }
  } catch (e) {
    logger.warn({ err: errMessage(e), publishJobId: job.id }, "Reconciliation lookup failed");
  }

  if (attempts < RECONCILE_MAX_ATTEMPTS) {
    await getQueues().publish.add("reconcile", { publishJobId: job.id }, { jobId: `reconcile-${job.id}-${attempts + 1}`, delay: RECONCILE_BASE_DELAY_MS * attempts });
    return "waiting";
  }
  // Checked several times over several minutes and the pin is not on the board: it was not created.
  if (job.attemptCount >= env.PUBLISH_MAX_ATTEMPTS) {
    await markFailed(c, "Publishing outcome stayed unknown and retries are exhausted.");
    return "failed";
  }
  const [s2] = await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "QUEUED", lastError: "Not found after reconciliation; retrying" }).where(eq(publishJobs.id, job.id));
    await tx.update(pinDrafts).set({ status: "SCHEDULED" }).where(eq(pinDrafts.id, draft.id));
    return tx
      .update(pinSchedules)
      .set({ status: "SCHEDULED", scheduledAt: new Date(Date.now() + 30_000), revision: schedule.revision + 1 })
      .where(eq(pinSchedules.id, schedule.id))
      .returning();
  });
  await getQueues().publish.add("publish", { scheduleId: s2!.id, revision: s2!.revision }, { jobId: publishJobId(s2!.id, s2!.revision), delay: 30_000 });
  await notifier.text(schedule.userId, `🔁 Pin ${draft.position} was not found on Pinterest after checking, so it will be retried shortly.`);
  return "retry_scheduled";
}

/** Batch number lookup helper for messages. */
export async function batchNumber(batchId: string) {
  return (await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) }))?.number;
}
