import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MockTextProvider, GradientImageProvider } from "../../src/modules/ai/mock.provider";
import { QuoteService } from "../../src/modules/ai/quote.service";
import { BoardAssignmentService } from "../../src/modules/boards/assignment.service";
import { renderQuoteImage } from "../../src/modules/images/renderer.service";
import { TextOverflowError } from "../../src/modules/images/typography.service";
import type { PinterestBoard } from "../../src/db/schema";

const opts = { topic: "broken trust", language: "English", tone: "sad", quoteLength: "medium" as const, imageStyle: "auto" as const, existingQuotes: [] };

const item = (quote: string) => ({
  topic: "Broken trust",
  emotion: "sad",
  quote,
  title: "Sad Quotes About Broken Trust",
  description: "Emotional quotes about broken trust, betrayal, heartbreak and healing after a difficult relationship.",
  keywords: ["broken trust quotes", "betrayal quotes"],
  alt_text: "An emotional quote about broken trust over a dark background.",
  style: "dark_cinematic",
  background_prompt: "Lonely silhouette near a rainy window, moody, no words.",
});

describe("QuoteService", () => {
  it("returns validated, unique quotes for a 7-pin batch", async () => {
    const svc = new QuoteService(new MockTextProvider());
    const items = await svc.generateBatch({ ...opts, count: 7 });
    expect(items).toHaveLength(7);
    expect(new Set(items.map((i) => i.quote)).size).toBe(7);
    for (const i of items) expect(i.title.length).toBeLessThanOrEqual(100);
  });

  it("regenerates only the duplicate slot", async () => {
    const p = new MockTextProvider();
    let call = 0;
    p.handlers.quotes = (req) => {
      call++;
      const n = Number(req.input!.count);
      if (call === 1) return { items: [item("I trusted you with everything I had."), item("I trusted you with everything I had!"), ...Array.from({ length: n - 2 }, () => item("Some doors close so the wind stops hurting."))] };
      return { items: Array.from({ length: n }, (_, k) => item(`Brand new healing thought number ${k} about learning to trust again`)) };
    };
    const items = await new QuoteService(p).generateBatch({ ...opts, count: 3 });
    expect(items).toHaveLength(3);
    expect(call).toBe(2);
    expect(items[0]!.quote).toBe("I trusted you with everything I had.");
  });

  it("rejects quotes that duplicate the user's existing quotes", async () => {
    const p = new MockTextProvider();
    p.handlers.quotes = () => ({ items: [item("You taught me that not every promise is meant to be kept.")] });
    const items = await new QuoteService(p).generateBatch({ ...opts, count: 1, existingQuotes: ["You taught me that not every promise is meant to be kept"] });
    expect(items).toHaveLength(0); // partial result; caller marks the pin failed
  });

  it("throws on AI output with missing fields (never trusts raw JSON)", async () => {
    const p = new MockTextProvider();
    p.handlers.quotes = () => ({ items: [{ quote: "only a quote" }] });
    await expect(new QuoteService(p).generateBatch({ ...opts, count: 1 })).rejects.toThrow();
  });
});

const board = (id: string, name: string): PinterestBoard => ({ id, name, externalBoardId: `ext-${id}`, description: null, privacy: "PUBLIC", isActive: true, lastSyncedAt: new Date(), pinterestAccountId: "a" });
const pins = [
  { id: "p1", topic: "Heartbreak", quote: "q", keywords: ["heartbreak quotes"], title: "Heartbreak" },
  { id: "p2", topic: "Healing", quote: "q", keywords: ["healing quotes"], title: "Healing" },
  { id: "p3", topic: "Gardening", quote: "q", keywords: ["plants"], title: "Plants" },
];

describe("BoardAssignmentService", () => {
  const boards = [board("b1", "Heartbreak Quotes"), board("b2", "Healing & Moving On"), board("b3", "Recipes")];
  const scorer = (scores: Record<string, Record<string, number>>, extra: object[] = []) => {
    const p = new MockTextProvider();
    p.handlers.board_scores = () => ({
      pins: [
        ...Object.entries(scores).map(([pin, row]) => ({ pin: Number(pin), scores: Object.entries(row).map(([b, s]) => ({ board: Number(b), score: s })), reason: "match" })),
        ...extra,
      ],
    });
    return new BoardAssignmentService(p);
  };

  it("auto-assigns relevant boards and leaves irrelevant pins for manual choice", async () => {
    const r = await scorer({ 1: { 1: 90, 2: 40 }, 2: { 2: 85, 1: 50 }, 3: { 3: 10 } }).assign("AUTO", pins, boards);
    expect(r.assignments.map((a) => a.boardId)).toEqual(["b1", "b2", null]);
    expect(r.unassigned).toEqual(["p3"]);
  });

  it("ignores hallucinated board numbers", async () => {
    const r = await scorer({ 1: { 99: 100, 1: 70 } }).assign("AUTO", pins.slice(0, 1), boards);
    expect(r.assignments[0]!.boardId).toBe("b1");
  });

  it("unique mode never reuses a board and reports insufficient boards", async () => {
    const r = await scorer({ 1: { 1: 90, 2: 60 }, 2: { 1: 88, 2: 80 }, 3: { 1: 70 } }).assign("UNIQUE", pins, boards);
    const ids = r.assignments.map((a) => a.boardId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.assignments.find((a) => a.draftId === "p1")!.boardId).toBe("b1");
    expect(r.assignments.find((a) => a.draftId === "p2")!.boardId).toBe("b2");
    expect(r.insufficientBoards).toBe(true);
  });

  it("falls back to keyword matching when the AI fails", async () => {
    const p = new MockTextProvider();
    p.handlers.board_scores = () => {
      throw new Error("AI down");
    };
    const r = await new BoardAssignmentService(p).assign("AUTO", pins.slice(0, 2), boards);
    expect(r.assignments.map((a) => a.boardId)).toEqual(["b1", "b2"]);
  });
});

describe("renderer", () => {
  const bg = () => new GradientImageProvider().generateBackground("", { style: "dark_cinematic", seed: 1 });

  it("produces a 1000x1500 JPEG", async () => {
    const r = await renderQuoteImage({ background: await bg(), quote: "You taught me that not every promise is meant to be kept.", style: "dark_cinematic", typography: "elegant_serif" });
    const m = await sharp(r.buffer).metadata();
    expect([m.width, m.height, m.format]).toEqual([1000, 1500, "jpeg"]);
    expect(r.textColor).toBe("#f7f1e8");
  });

  it("shrinks fonts for long quotes using measured layout", async () => {
    const short = await renderQuoteImage({ background: await bg(), quote: "Let go.", style: "dark_cinematic", typography: "modern_sans" });
    const long = await renderQuoteImage({ background: await bg(), quote: "Some people leave quietly, and the silence they leave behind becomes the loudest thing in the room for a very long time, and you learn to live beside it.", style: "dark_cinematic", typography: "modern_sans" });
    expect(long.fontSize).toBeLessThan(short.fontSize);
  });

  it("uses dark text on light backgrounds", async () => {
    const light = await new GradientImageProvider({ beige_editorial: ["#f5efe6", "#efe6d8", "#e8dccb"] }).generateBackground("", { style: "beige_editorial", seed: 2 });
    const r = await renderQuoteImage({ background: light, quote: "Healing is quiet work.", style: "beige_editorial", typography: "book_serif" });
    expect(r.textColor).toBe("#2a2420");
  });

  it("refuses text that cannot fit instead of overflowing", async () => {
    await expect(renderQuoteImage({ background: await bg(), quote: "word ".repeat(400), style: "dark_cinematic", typography: "elegant_serif" })).rejects.toBeInstanceOf(TextOverflowError);
  });

  it("accepts non-2:3 AI backgrounds (e.g. Imagen 3:4) and crops to 2:3", async () => {
    const wide = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#203040" } }).png().toBuffer();
    const r = await renderQuoteImage({ background: wide, quote: "Still here.", style: "moody_blue", typography: "serif_italic", watermark: "@brand" });
    expect([r.width, r.height]).toEqual([1000, 1500]);
  });
});

describe("Gemini schema conversion", () => {
  it("keeps only the documented JSON Schema subset", async () => {
    const { toGeminiSchema } = await import("../../src/modules/ai/gemini.provider");
    const { z } = await import("zod");
    const { QuoteBatchSchema } = await import("../../src/modules/ai/schemas");
    const s = JSON.stringify(toGeminiSchema(z.toJSONSchema(QuoteBatchSchema, { target: "draft-7" })));
    expect(s).not.toContain("$schema");
    expect(s).not.toContain("minLength");
    expect(s).toContain('"properties"');
    expect(s).toContain('"enum"');
  });
});

describe("aesthetic layout", () => {
  it("puts text on a frosted card over busy backgrounds", async () => {
    const dots = Array.from({ length: 300 }, (_, i) => `<circle cx="${(i * 97) % 1000}" cy="${(i * 211) % 1500}" r="${10 + (i % 25)}" fill="${["#d98ba0", "#7d9c6b", "#fbeee6"][i % 3]}"/>`).join("");
    const busy = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500"><rect width="100%" height="100%" fill="#e9c9c4"/>${dots}</svg>`)).png().toBuffer();
    const r = await renderQuoteImage({ background: busy, quote: "My heart is learning to choose better.", style: "soft_romantic", typography: "elegant_serif" });
    expect(r.layout).toBe("frosted");
  });
  it("keeps calm backgrounds clean", async () => {
    const calm = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: "#203040" } }).png().toBuffer();
    const r = await renderQuoteImage({ background: calm, quote: "Still here.", style: "moody_blue", typography: "classic_serif" });
    expect(r.layout).toBe("clean");
  });
});
