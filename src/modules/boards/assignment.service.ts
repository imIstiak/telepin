import { logger } from "../../config/logger";
import type { PinterestBoard } from "../../db/schema";
import { keywordScore } from "../ai/mock.provider";
import type { TextProvider } from "../ai/provider.interface";
import { BoardScoresSchema } from "../ai/schemas";

export const MIN_RELEVANCE = 45;

export interface PinForAssignment {
  id: string;
  topic: string;
  quote: string;
  keywords: string[];
  title: string;
}

export interface Assignment {
  draftId: string;
  boardId: string | null;
  score: number;
  reason: string;
}

export interface AssignmentResult {
  assignments: Assignment[];
  unassigned: string[];
  /** Unique mode only: not enough distinct relevant boards. */
  insufficientBoards: boolean;
}

type ScoreMatrix = Map<string, Map<string, number>>; // draftId -> boardId -> score
type Reasons = Map<string, string>;

function pinText(p: PinForAssignment) {
  return `${p.topic}. ${p.title}. ${p.keywords.join(", ")}. ${p.quote}`;
}
function boardText(b: PinterestBoard) {
  return `${b.name}${b.description ? ` - ${b.description}` : ""}`;
}

export class BoardAssignmentService {
  constructor(private provider: TextProvider) {}

  async score(pins: PinForAssignment[], boards: PinterestBoard[]): Promise<{ matrix: ScoreMatrix; reasons: Reasons; source: "ai" | "keywords" }> {
    const matrix: ScoreMatrix = new Map(pins.map((p) => [p.id, new Map()]));
    const reasons: Reasons = new Map();
    try {
      const res = await this.provider.generateJson({
        task: "board_scores",
        input: {
          pins: pins.map((p, i) => ({ n: i + 1, text: pinText(p) })),
          boards: boards.map((b, i) => ({ n: i + 1, text: boardText(b) })),
        },
        system:
          "You match Pinterest pins to the user's EXISTING boards by topical relevance. Only use the board numbers given. Score 0-100 where 70+ = clearly relevant, 45-69 = acceptable, below 45 = not relevant. Never invent boards.",
        prompt: `Pins:\n${pins.map((p, i) => `${i + 1}. ${pinText(p)}`).join("\n")}\n\nBoards:\n${boards
          .map((b, i) => `${i + 1}. ${boardText(b)}`)
          .join("\n")}\n\nFor EVERY pin return up to 5 best candidate boards with scores and a short reason (max 15 words). JSON: {"pins":[{"pin":1,"scores":[{"board":3,"score":82}],"reason":"..."}]}`,
        schema: BoardScoresSchema,
        temperature: 0.2,
      });
      for (const r of res.pins) {
        const pin = pins[r.pin - 1];
        if (!pin) continue;
        for (const s of r.scores) {
          const board = boards[s.board - 1];
          if (board) matrix.get(pin.id)!.set(board.id, s.score); // ignore hallucinated board numbers
        }
        reasons.set(pin.id, r.reason);
      }
      return { matrix, reasons, source: "ai" };
    } catch (e) {
      logger.warn({ err: e }, "AI board scoring failed; falling back to keyword matching");
      for (const p of pins) for (const b of boards) matrix.get(p.id)!.set(b.id, keywordScore(pinText(p), boardText(b)));
      return { matrix, reasons, source: "keywords" };
    }
  }

  async assign(mode: "AUTO" | "UNIQUE", pins: PinForAssignment[], boards: PinterestBoard[], preferredBoardId?: string | null): Promise<AssignmentResult> {
    if (boards.length === 0) return { assignments: pins.map((p) => ({ draftId: p.id, boardId: null, score: 0, reason: "No boards" })), unassigned: pins.map((p) => p.id), insufficientBoards: true };
    const { matrix, reasons, source } = await this.score(pins, boards);
    const reasonFor = (id: string, score: number) => reasons.get(id) ?? (source === "keywords" ? `keyword match (${score})` : `relevance ${score}`);
    const assignments: Assignment[] = [];

    if (mode === "AUTO") {
      for (const p of pins) {
        let best: { boardId: string; score: number } | null = null;
        for (const [boardId, score] of matrix.get(p.id)!) if (!best || score > best.score) best = { boardId, score };
        if (best && best.score >= MIN_RELEVANCE) assignments.push({ draftId: p.id, boardId: best.boardId, score: best.score, reason: reasonFor(p.id, best.score) });
        else if (preferredBoardId && boards.some((b) => b.id === preferredBoardId))
          assignments.push({ draftId: p.id, boardId: preferredBoardId, score: best?.score ?? 0, reason: "Your preferred board (no strong topical match)" });
        else assignments.push({ draftId: p.id, boardId: null, score: best?.score ?? 0, reason: "No relevant board found — choose manually" });
      }
      return { assignments, unassigned: assignments.filter((a) => !a.boardId).map((a) => a.draftId), insufficientBoards: false };
    }

    // UNIQUE: greedy maximum-relevance matching with distinct boards; never force irrelevant boards.
    const pairs: { draftId: string; boardId: string; score: number }[] = [];
    for (const [draftId, row] of matrix) for (const [boardId, score] of row) if (score >= MIN_RELEVANCE) pairs.push({ draftId, boardId, score });
    pairs.sort((a, b) => b.score - a.score);
    const usedBoards = new Set<string>();
    const done = new Map<string, Assignment>();
    for (const pr of pairs) {
      if (done.has(pr.draftId) || usedBoards.has(pr.boardId)) continue;
      usedBoards.add(pr.boardId);
      done.set(pr.draftId, { ...pr, reason: reasonFor(pr.draftId, pr.score) });
    }
    for (const p of pins) assignments.push(done.get(p.id) ?? { draftId: p.id, boardId: null, score: 0, reason: "No distinct relevant board left — choose manually" });
    const unassigned = assignments.filter((a) => !a.boardId).map((a) => a.draftId);
    return { assignments, unassigned, insufficientBoards: unassigned.length > 0 };
  }
}
