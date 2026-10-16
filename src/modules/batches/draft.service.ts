import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../../config/database";
import { imageAssets, pinDrafts, pinterestBoards, type DraftStatus, type PinDraft } from "../../db/schema";
import { audit } from "../audit/audit.service";
import { EDITABLE_DRAFT_STATES, assertDraftTransition } from "../state/state-machine";

export class StaleActionError extends Error {
  constructor(message = "This button is out of date — the pin changed since. Open the latest preview and try again.") {
    super(message);
  }
}
export class NotFoundError extends Error {
  constructor(message = "Not found or not yours.") {
    super(message);
  }
}
export class InvalidStateError extends Error {}

export async function getOwnedDraft(userId: string, draftId: string, tx: DbOrTx = db): Promise<PinDraft> {
  const d = await tx.query.pinDrafts.findFirst({ where: and(eq(pinDrafts.id, draftId), eq(pinDrafts.userId, userId)) });
  if (!d) throw new NotFoundError("Pin not found or not yours.");
  return d;
}

export async function listBatchDrafts(batchId: string, tx: DbOrTx = db) {
  return tx.select().from(pinDrafts).where(eq(pinDrafts.batchId, batchId)).orderBy(asc(pinDrafts.position));
}

export type DraftContentChange = Partial<
  Pick<PinDraft, "quote" | "title" | "description" | "keywords" | "altText" | "link" | "imageStyle" | "typography" | "backgroundPrompt" | "selectedBoardId" | "boardReason" | "topic" | "emotion">
>;

/**
 * The single entry point for user-initiated content changes. It:
 *  - checks ownership and the caller's expected version (rejects stale Telegram buttons),
 *  - refuses edits while a pin is scheduled/publishing/published,
 *  - bumps the version and invalidates any previous approval.
 */
export async function changeDraft(
  userId: string,
  draftId: string,
  expectedVersion: number | null,
  change: DraftContentChange,
  opts: { status?: DraftStatus; action: string },
): Promise<PinDraft> {
  return db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(pinDrafts)
      .where(and(eq(pinDrafts.id, draftId), eq(pinDrafts.userId, userId)))
      .for("update");
    if (!d) throw new NotFoundError("Pin not found or not yours.");
    if (expectedVersion !== null && d.version !== expectedVersion) throw new StaleActionError();
    if (!EDITABLE_DRAFT_STATES.includes(d.status)) {
      throw new InvalidStateError(
        d.status === "SCHEDULED"
          ? "This pin is scheduled. Pause or cancel its schedule (/queue) before editing."
          : `This pin can't be edited while it is ${d.status.toLowerCase().replace(/_/g, " ")}.`,
      );
    }
    const nextStatus = opts.status ?? "READY_FOR_REVIEW";
    assertDraftTransition(d.status, nextStatus);
    const wasApproved = d.approvalStatus === "APPROVED";
    const [u] = await tx
      .update(pinDrafts)
      .set({
        ...change,
        status: nextStatus,
        version: d.version + 1,
        approvalStatus: d.approvalStatus === "REJECTED" ? "REJECTED" : "PENDING",
        approvedVersion: null,
        lastError: null,
      })
      .where(eq(pinDrafts.id, d.id))
      .returning();
    await audit({ userId, draftId, batchId: d.batchId, action: opts.action, details: { fromVersion: d.version, approvalInvalidated: wasApproved, fields: Object.keys(change) } }, tx);
    return u!;
  });
}

export async function approveDraft(userId: string, draftId: string, version: number): Promise<PinDraft> {
  const d = await getOwnedDraft(userId, draftId);
  if (d.version !== version) throw new StaleActionError();
  if (d.status === "APPROVED") return d;
  if (!["READY_FOR_REVIEW", "NEEDS_EDIT"].includes(d.status)) throw new InvalidStateError(`Pin is ${d.status.toLowerCase()} and can't be approved now.`);
  if (!d.selectedImageId) throw new InvalidStateError("This pin has no finished image yet.");
  if (!d.selectedBoardId) throw new InvalidStateError("Assign a board to this pin before approving it.");
  const [u] = await db
    .update(pinDrafts)
    .set({ status: "APPROVED", approvalStatus: "APPROVED", approvedVersion: d.version })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, version), inArray(pinDrafts.status, ["READY_FOR_REVIEW", "NEEDS_EDIT"])))
    .returning();
  if (!u) throw new StaleActionError();
  await audit({ userId, draftId, batchId: d.batchId, action: "draft.approved", details: { version } });
  return u;
}

export async function rejectDraft(userId: string, draftId: string, version: number): Promise<PinDraft> {
  const d = await getOwnedDraft(userId, draftId);
  if (d.version !== version) throw new StaleActionError();
  if (!EDITABLE_DRAFT_STATES.includes(d.status) && d.status !== "GENERATING") throw new InvalidStateError(`Pin is ${d.status.toLowerCase()}.`);
  const [u] = await db
    .update(pinDrafts)
    .set({ status: "CANCELLED", approvalStatus: "REJECTED", approvedVersion: null })
    .where(and(eq(pinDrafts.id, d.id), eq(pinDrafts.version, version)))
    .returning();
  if (!u) throw new StaleActionError();
  await audit({ userId, draftId, batchId: d.batchId, action: "draft.rejected" });
  return u;
}

/** Approves every ready pin that has an image and a board. Returns which pins still need attention. */
export async function approveAll(userId: string, batchId: string) {
  const drafts = await listBatchDrafts(batchId);
  if (drafts[0] && drafts[0].userId !== userId) throw new NotFoundError();
  const approved: number[] = [];
  const missingBoard: number[] = [];
  const notReady: number[] = [];
  for (const d of drafts) {
    if (d.status === "CANCELLED" || d.approvalStatus === "REJECTED") continue;
    if (d.status === "APPROVED") {
      approved.push(d.position);
      continue;
    }
    if (!["READY_FOR_REVIEW", "NEEDS_EDIT"].includes(d.status) || !d.selectedImageId) {
      notReady.push(d.position);
      continue;
    }
    if (!d.selectedBoardId) {
      missingBoard.push(d.position);
      continue;
    }
    await approveDraft(userId, d.id, d.version);
    approved.push(d.position);
  }
  return { approved, missingBoard, notReady };
}

export async function getFinalImage(d: PinDraft, tx: DbOrTx = db) {
  if (!d.selectedImageId) return null;
  return (await tx.query.imageAssets.findFirst({ where: eq(imageAssets.id, d.selectedImageId) })) ?? null;
}

export async function getDraftBoard(d: PinDraft) {
  if (!d.selectedBoardId) return null;
  return (await db.query.pinterestBoards.findFirst({ where: eq(pinterestBoards.id, d.selectedBoardId) })) ?? null;
}

export async function recentQuotes(userId: string, limit = 300): Promise<string[]> {
  const rows = await db
    .select({ quote: pinDrafts.quote })
    .from(pinDrafts)
    .where(and(eq(pinDrafts.userId, userId), isNotNull(pinDrafts.quote), sql`${pinDrafts.status} <> 'CANCELLED'`))
    .orderBy(desc(pinDrafts.createdAt))
    .limit(limit);
  return rows.map((r) => r.quote!).filter(Boolean);
}
