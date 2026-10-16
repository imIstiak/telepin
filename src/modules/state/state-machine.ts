import type { BatchStatus, DraftStatus } from "../../db/schema";

const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  CREATED: ["GENERATING", "CANCELLED", "FAILED"],
  GENERATING: ["READY_FOR_REVIEW", "FAILED", "CANCELLED"],
  READY_FOR_REVIEW: ["GENERATING", "NEEDS_EDIT", "APPROVED", "CANCELLED", "READY_FOR_REVIEW"],
  NEEDS_EDIT: ["GENERATING", "READY_FOR_REVIEW", "APPROVED", "CANCELLED"],
  APPROVED: ["READY_FOR_REVIEW", "GENERATING", "NEEDS_EDIT", "SCHEDULED", "CANCELLED"],
  SCHEDULED: ["PUBLISHING", "APPROVED", "CANCELLED", "READY_FOR_REVIEW"],
  PUBLISHING: ["PUBLISHED", "FAILED", "PUBLISH_UNKNOWN", "SCHEDULED"],
  PUBLISH_UNKNOWN: ["PUBLISHED", "SCHEDULED", "FAILED", "PUBLISHING"],
  FAILED: ["GENERATING", "READY_FOR_REVIEW", "APPROVED", "SCHEDULED", "CANCELLED"],
  PUBLISHED: [],
  CANCELLED: [],
};

const BATCH_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  CREATED: ["GENERATING", "CANCELLED", "FAILED"],
  GENERATING: ["PARTIALLY_READY", "READY_FOR_REVIEW", "FAILED", "CANCELLED"],
  PARTIALLY_READY: ["READY_FOR_REVIEW", "GENERATING", "APPROVED", "CANCELLED", "SCHEDULED"],
  READY_FOR_REVIEW: ["APPROVED", "CANCELLED", "SCHEDULED", "PARTIALLY_READY", "READY_FOR_REVIEW"],
  APPROVED: ["SCHEDULED", "READY_FOR_REVIEW", "CANCELLED"],
  SCHEDULED: ["PARTIALLY_PUBLISHED", "COMPLETED", "CANCELLED", "READY_FOR_REVIEW", "FAILED"],
  PARTIALLY_PUBLISHED: ["COMPLETED", "CANCELLED", "FAILED", "PARTIALLY_PUBLISHED"],
  FAILED: ["GENERATING", "READY_FOR_REVIEW", "CANCELLED", "SCHEDULED", "PARTIALLY_PUBLISHED", "COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(kind: string, from: string, to: string) {
    super(`Invalid ${kind} transition ${from} → ${to}`);
  }
}

export function canTransitionDraft(from: DraftStatus, to: DraftStatus) {
  return from === to || DRAFT_TRANSITIONS[from].includes(to);
}
export function assertDraftTransition(from: DraftStatus, to: DraftStatus) {
  if (!canTransitionDraft(from, to)) throw new InvalidTransitionError("draft", from, to);
}
export function canTransitionBatch(from: BatchStatus, to: BatchStatus) {
  return from === to || BATCH_TRANSITIONS[from].includes(to);
}
export function assertBatchTransition(from: BatchStatus, to: BatchStatus) {
  if (!canTransitionBatch(from, to)) throw new InvalidTransitionError("batch", from, to);
}

/** Draft states in which content may be edited by the user. */
export const EDITABLE_DRAFT_STATES: DraftStatus[] = ["READY_FOR_REVIEW", "NEEDS_EDIT", "APPROVED", "FAILED"];

/** Derive the batch status from its drafts (used after every draft change). */
export function deriveBatchStatus(drafts: { status: DraftStatus; approvalStatus: string }[], current: BatchStatus): BatchStatus {
  if (current === "CANCELLED") return current;
  const live = drafts.filter((d) => d.status !== "CANCELLED" && d.approvalStatus !== "REJECTED");
  if (live.length === 0) return drafts.length ? "CANCELLED" : current;
  const count = (s: DraftStatus[]) => live.filter((d) => s.includes(d.status)).length;
  const published = count(["PUBLISHED"]);
  if (published === live.length) return "COMPLETED";
  if (published > 0) return "PARTIALLY_PUBLISHED";
  if (count(["SCHEDULED", "PUBLISHING", "PUBLISH_UNKNOWN"]) > 0) return "SCHEDULED";
  if (count(["GENERATING", "CREATED"]) > 0) {
    return count(["READY_FOR_REVIEW", "APPROVED", "NEEDS_EDIT"]) > 0 ? "PARTIALLY_READY" : "GENERATING";
  }
  if (count(["APPROVED"]) === live.length) return "APPROVED";
  if (count(["FAILED"]) === live.length) return "FAILED";
  if (count(["FAILED"]) > 0) return "PARTIALLY_READY";
  return "READY_FOR_REVIEW";
}
