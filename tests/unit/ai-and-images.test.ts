import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MockTextProvider, GradientImageProvider } from "../../src/modules/ai/mock.provider";
import { QuoteService } from "../../src/modules/ai/quote.service";
import { BoardAssignmentService } from "../../src/modules/boards/assignment.service";
import { hammingDistance, MARGIN_X, MARGIN_Y, perceptualHash, renderQuoteImage } from "../../src/modules/images/renderer.service";
import { buildBackgroundPrompt, GLOBAL_NEGATIVE, IMAGE_STYLES, IMAGE_STYLE_KEYS, resolveStyle } from "../../src/modules/images/styles";
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
  style: "dark_romantic",
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

describe("renderer (style system V2)", () => {
  const bg = (style: string, seed = 1) => new GradientImageProvider(Object.fromEntries(IMAGE_STYLE_KEYS.map((k) => [k, IMAGE_STYLES[k].fallback]))).generateBackground("", { style, seed });

  it("produces a 1000x1500 sRGB JPEG that passes QA", async () => {
    const r = await renderQuoteImage({ background: await bg("rainy_window"), quote: "You taught me that not every promise is meant to be kept.", style: "rainy_window" });
    const m = await sharp(r.buffer).metadata();
    expect([m.width, m.height, m.format, m.space]).toEqual([1000, 1500, "jpeg", "srgb"]);
    expect(r.qa.passed).toBe(true);
    expect(r.textColor).toBe(IMAGE_STYLES.rainy_window.text.light);
    expect(r.typography).toBe("classic_serif");
  });

  it("chooses the style's dark text on light backgrounds", async () => {
    const r = await renderQuoteImage({ background: await bg("minimal_typography"), quote: "Protect your peace like it matters.", style: "minimal_typography" });
    expect(r.textColor).toBe(IMAGE_STYLES.minimal_typography.text.dark);
    expect(r.layout).toBe("clean");
  });

  it("sizes short quotes 94–110px and long quotes smaller (Cormorant)", async () => {
    const short = await renderQuoteImage({ background: await bg("soft_feminine_editorial"), quote: "You are allowed to bloom slowly.", style: "soft_feminine_editorial" });
    const long = await renderQuoteImage({ background: await bg("soft_feminine_editorial"), quote: "Some people leave quietly, and the silence they leave behind becomes the loudest thing in the room for a very long time.", style: "soft_feminine_editorial" });
    expect(short.fontSize).toBeGreaterThanOrEqual(94);
    expect(short.fontSize).toBeLessThanOrEqual(110);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(long.fontSize).toBeGreaterThanOrEqual(60);
  });

  it("keeps the quote inside the safe margins", async () => {
    const r = await renderQuoteImage({ background: await bg("dreamy_sky"), quote: "Some days the bravest thing you can do is begin again, softly, without telling anyone.", style: "dreamy_sky" });
    expect(r.box.left).toBeGreaterThanOrEqual(MARGIN_X - 1);
    expect(r.box.top).toBeGreaterThanOrEqual(MARGIN_Y);
    expect(r.box.top + r.box.height).toBeLessThanOrEqual(1500 - MARGIN_Y);
    expect(r.qa.safeMargins && r.qa.noClipping).toBe(true);
  });

  it("refuses text that cannot fit instead of overflowing", async () => {
    await expect(renderQuoteImage({ background: await bg("dark_romantic"), quote: "word ".repeat(400), style: "dark_romantic" })).rejects.toBeInstanceOf(TextOverflowError);
  });

  it("accepts non-2:3 AI backgrounds and maps legacy style ids", async () => {
    const wide = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#203040" } }).png().toBuffer();
    const r = await renderQuoteImage({ background: wide, quote: "Still here.", style: "moody_blue" });
    expect([r.width, r.height]).toEqual([1000, 1500]);
    expect(resolveStyle("moody_blue")).toBe("peaceful_ocean");
    expect(resolveStyle("dark_cinematic")).toBe("dark_romantic");
  });

  it("uses a soft veil (never a panel) or moves region when contrast is poor", async () => {
    const dots = Array.from({ length: 300 }, (_, i) => `<circle cx="${(i * 97) % 1000}" cy="${(i * 211) % 1500}" r="${10 + (i % 25)}" fill="${["#202020", "#f0f0f0", "#808080"][i % 3]}"/>`).join("");
    const busy = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500"><rect width="100%" height="100%" fill="#777"/>${dots}</svg>`)).png().toBuffer();
    const r = await renderQuoteImage({ background: busy, quote: "My heart is learning to choose better.", style: "dark_romantic" });
    expect(r.layout).toBe("veil");
    expect(r.veilStrength).toBeGreaterThan(0);
  });
});

describe("style config", () => {
  it("defines all 10 V2 styles with complete config", () => {
    expect(IMAGE_STYLE_KEYS).toHaveLength(10);
    for (const k of IMAGE_STYLE_KEYS) {
      const s = IMAGE_STYLES[k];
      expect(s.fallback).toHaveLength(3);
      expect(s.variations.light.length).toBeGreaterThan(0);
      expect(["upper", "upper_middle", "middle", "lower"]).toContain(s.textRegion);
    }
  });

  it("builds prompts in the required order with global negatives", () => {
    const p = buildBackgroundPrompt("vintage_paper", "a dried rose on an old letter", 1);
    const iStyle = p.indexOf("vintage stationery");
    const iHint = p.indexOf("Optional creative detail");
    const iComp = p.indexOf("Composition:");
    const iLight = p.indexOf("Lighting:");
    const iQual = p.indexOf("Quality:");
    const iNeg = p.indexOf("Avoid:");
    expect([iStyle, iHint, iComp, iLight, iQual, iNeg].every((x, i, a) => x >= 0 && (i === 0 || x > a[i - 1]!))).toBe(true);
    expect(p).toContain(GLOBAL_NEGATIVE);
  });

  it("varies prompts across a batch", () => {
    expect(buildBackgroundPrompt("rainy_window", null, 0)).not.toBe(buildBackgroundPrompt("rainy_window", null, 1));
  });

  it("perceptual hash flags identical images and separates different ones", async () => {
    const a = await bg2("#203040", "#90a0b0");
    const b = await bg2("#f0e0d0", "#302010");
    expect(hammingDistance(await perceptualHash(a), await perceptualHash(a))).toBe(0);
    expect(hammingDistance(await perceptualHash(a), await perceptualHash(b))).toBeGreaterThan(6);
  });
});

const bg2 = (c1: string, c2: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`)).png().toBuffer();

describe("Gemini schema conversion", () => {
  it("keeps only the documented JSON Schema subset", async () => {
    const { toGeminiSchema } = await import("../../src/modules/ai/gemini.provider");
    const { z } = await import("zod");
    const { QuoteBatchSchema } = await import("../../src/modules/ai/schemas");
    const s = JSON.stringify(toGeminiSchema(z.toJSONSchema(QuoteBatchSchema, { target: "draft-7" })));
    expect(s).not.toContain("$schema");
    expect(s).not.toContain("minLength");
    expect(s).toContain('"properties"');
    expect(s).toContain('"description"');
  });
});


describe("style selection", () => {
  it("manual style overrides the AI's choice; legacy/unknown AI styles are normalised", async () => {
    const p = new MockTextProvider();
    p.handlers.quotes = () => ({ items: [{ ...item("Rain remembers the names we stopped saying."), style: "dark_cinematic" }] });
    const manual = await new QuoteService(p).generateBatch({ ...opts, count: 1, imageStyle: "peaceful_ocean" });
    expect(manual[0]!.style).toBe("peaceful_ocean");
    const auto = await new QuoteService(p).generateBatch({ ...opts, count: 1 });
    expect(auto[0]!.style).toBe("dark_romantic");
  });
});
