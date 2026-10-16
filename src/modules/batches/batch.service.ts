import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { pinBatches, pinDrafts, type BoardAssignmentMode, type PinBatch } from "../../db/schema";
import { getQueues } from "../../queues";
import { getTextProvider } from "../ai/providers";
import { audit } from "../audit/audit.service";
import { BoardAssignmentService, type AssignmentResult } from "../boards/assignment.service";
import { getOwnedBoard, listBoards } from "../pinterest/boards.service";
import { deriveBatchStatus } from "../state/state-machine";
import { getSettings } from "../users/user.service";
import { changeDraft, InvalidStateError, listBatchDrafts, NotFoundError } from "./draft.service";

export const ALLOWED_COUNTS = [1, 3, 5, 7] as const;

export function validateCount(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > env.MAX_BATCH_SIZE) {
    throw new InvalidStateError(`Number of pins must be between 1 and ${env.MAX_BATCH_SIZE}.`);
  }
  return n;
}

export function validateTopic(topic: string): string {
  const t = topic.replace(/\s+/g, " ").trim();
  if (t.length < 2) throw new InvalidStateError("Please send a topic or some keywords.");
  if (t.length > 200) throw new InvalidStateError("Topic is too long (max 200 characters).");
  return t;
}

export async function createBatch(userId: string, topic: string, count: number): Promise<PinBatch> {
  const t = validateTopic(topic);
  const n = validateCount(count);
  const settings = await getSettings(userId);
  const batch = await db.transaction(async (tx) => {
    const [b] = await tx
      .insert(pinBatches)
      .values({ userId, originalTopic: t, requestedCount: n, boardAssignmentMode: settings.defaultBoardAssignmentMode, status: "GENERATING" })
      .returning();
    await tx.insert(pinDrafts).values(
      Array.from({ length: n }, (_, i) => ({
        batchId: b!.id,
        userId,
        position: i + 1,
        topic: t,
        status: "GENERATING" as const,
        typography: settings.typographyPreset,
        link: settings.defaultLink,
      })),
    );
    await audit({ userId, batchId: b!.id, action: "batch.created", details: { topic: t, count: n } }, tx);
    return b!;
  });
  await getQueues().content.add("batch", { kind: "batch", batchId: batch.id }, { jobId: `content-${batch.id}` });
  return batch;
}

export async function getOwnedBatch(userId: string, batchId: string): Promise<PinBatch> {
  const b = await db.query.pinBatches.findFirst({ where: and(eq(pinBatches.id, batchId), eq(pinBatches.userId, userId)) });
  if (!b) throw new NotFoundError("Batch not found or not yours.");
  return b;
}

export async function getBatchByNumber(userId: string, number: number) {
  return db.query.pinBatches.findFirst({ where: and(eq(pinBatches.number, number), eq(pinBatches.userId, userId)) });
}

export async function listBatches(userId: string, limit = 10) {
  return db.select().from(pinBatches).where(eq(pinBatches.userId, userId)).orderBy(desc(pinBatches.createdAt)).limit(limit);
}

/**
 * Recomputes batch status from its drafts. Returns `becameReady` exactly once per batch
 * (when generation has finished for all drafts), using an atomic flag so only one worker notifies.
 */
export async function refreshBatchStatus(batchId: string): Promise<{ batch: PinBatch; becameReady: boolean }> {
  const batch = await db.query.pinBatches.findFirst({ where: eq(pinBatches.id, batchId) });
  if (!batch) throw new NotFoundError();
  const drafts = await listBatchDrafts(batchId);
  const status = deriveBatchStatus(drafts, batch.status);
  const generatedCount = drafts.filter((d) => d.selectedImageId).length;
  let [updated] = await db.update(pinBatches).set({ status, generatedCount }).where(eq(pinBatches.id, batchId)).returning();
  const stillGenerating = drafts.some((d) => d.status === "GENERATING" || d.status === "CREATED");
  let becameReady = false;
  if (!stillGenerating && !batch.readyNotifiedAt) {
    const [flagged] = await db
      .update(pinBatches)
      .set({ readyNotifiedAt: new Date() })
      .where(and(eq(pinBatches.id, batchId), isNull(pinBatches.readyNotifiedAt)))
      .returning();
    if (flagged) {
      becameReady = true;
      updated = flagged;
    }
  }
  return { batch: updated!, becameReady };
}

export async function cancelBatch(userId: string, batchId: string) {
  const b = await getOwnedBatch(userId, batchId);
  if (["COMPLETED", "CANCELLED"].includes(b.status)) throw new InvalidStateError(`Batch is already ${b.status.toLowerCase()}.`);
  const { cancelBatchSchedules } = await import("../scheduling/schedule.service");
  await cancelBatchSchedules(userId, batchId);
  await db
    .update(pinDrafts)
    .set({ status: "CANCELLED", approvedVersion: null })
    .where(and(eq(pinDrafts.batchId, batchId), inArray(pinDrafts.status, ["CREATED", "GENERATING", "READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED", "SCHEDULED"])));
  await db.update(pinBatches).set({ status: "CANCELLED", schedulePlan: null }).where(eq(pinBatches.id, batchId));
  await audit({ userId, batchId, action: "batch.cancelled" });
}

/** Board assignment for all reviewable pins in a batch (AUTO or UNIQUE). Changes invalidate approvals. */
export async function autoAssignBoards(userId: string, batchId: string, mode: "AUTO" | "UNIQUE"): Promise<AssignmentResult & { boardCount: number }> {
  const batch = await getOwnedBatch(userId, batchId);
  const boards = await listBoards(userId);
  if (boards.length === 0) throw new InvalidStateError("No Pinterest boards found. Use /connect, then /boards to sync (boards are never created automatically).");
  const drafts = (await listBatchDrafts(batch.id)).filter((d) => ["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED"].includes(d.status) && d.quote);
  if (drafts.length === 0) throw new InvalidStateError("No pins in this batch are ready for board assignment.");
  const settings = await getSettings(userId);
  const svc = new BoardAssignmentService(getTextProvider());
  const result = await svc.assign(
    mode,
    drafts.map((d) => ({ id: d.id, topic: d.topic, quote: d.quote ?? "", keywords: d.keywords, title: d.title ?? "" })),
    boards,
    settings.preferredBoardId,
  );
  for (const a of result.assignments) {
    const d = drafts.find((x) => x.id === a.draftId)!;
    if (d.selectedBoardId === a.boardId) continue;
    await changeDraft(userId, d.id, null, { selectedBoardId: a.boardId, boardReason: a.reason }, { action: `board.${mode.toLowerCase()}_assigned`, status: d.status === "FAILED" ? "FAILED" : "READY_FOR_REVIEW" });
  }
  await db.update(pinBatches).set({ boardAssignmentMode: mode as BoardAssignmentMode }).where(eq(pinBatches.id, batch.id));
  await refreshBatchStatus(batch.id);
  return { ...result, boardCount: boards.length };
}

export async function setDraftBoard(userId: string, draftId: string, version: number, boardId: string) {
  const board = await getOwnedBoard(userId, boardId);
  if (!board) throw new NotFoundError("That board isn't available on your connected Pinterest account.");
  const d = await changeDraft(userId, draftId, version, { selectedBoardId: board.id, boardReason: "Chosen manually" }, { action: "board.manual_assigned" });
  // Unique mode: warn (don't block) if another pin in the batch already uses this board.
  const siblings = await listBatchDrafts(d.batchId);
  const duplicateOf = siblings.filter((s) => s.id !== d.id && s.selectedBoardId === board.id && s.status !== "CANCELLED").map((s) => s.position);
  await refreshBatchStatus(d.batchId);
  return { draft: d, board, duplicateOf };
}
