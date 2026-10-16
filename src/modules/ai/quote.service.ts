import { logger } from "../../config/logger";
import { cleanQuote, cosine, lexicalSimilarity, wordCount } from "../../utils/text";
import { isImageStyle, type ImageStyle } from "../images/styles";
import type { TextProvider } from "./provider.interface";
import { QuoteBatchSchema, type QuoteItem } from "./schemas";
import { normalizeSeo } from "./seo.service";

export type QuoteLength = "short" | "medium" | "long";
export const QUOTE_LENGTH_RANGES: Record<QuoteLength, [number, number]> = {
  short: [5, 14],
  medium: [8, 25],
  long: [18, 40],
};

export interface QuoteGenerationOptions {
  topic: string;
  count: number;
  language: string;
  tone: string;
  quoteLength: QuoteLength;
  /** "auto" lets the model choose a style per pin. */
  imageStyle: ImageStyle | "auto";
  existingQuotes: string[];
}

export const LEXICAL_DUP_THRESHOLD = 0.55;
export const SEMANTIC_DUP_THRESHOLD = 0.9;

const SYSTEM = `You are an expert Pinterest content strategist and a talented original writer of short emotional quotes.
Rules:
- Every quote must be ORIGINAL (never a known quote, lyric or line from a book/film), natural, grammatically correct and emotionally meaningful.
- Never attribute quotes to any author or person. No names, no hashtags inside the quote, no emojis.
- No hateful, harassing, sexual, violent, self-harm-encouraging or otherwise harmful content. Sad themes are fine; keep them healthy and human.
- Quotes must read well when displayed on an image: short sentences, no awkward line structure.
- Each quote in a batch must be clearly different in wording, imagery and angle.
- Titles and descriptions must be accurate, not misleading, and use keywords naturally without stuffing. Pinterest has no tags field; keywords are for natural use in the description.
- background_prompt describes ONLY a visual scene (no text, letters or words) with calm negative space for text placement.`;

function buildPrompt(o: QuoteGenerationOptions, n: number, avoid: string[]): string {
  const [minW, maxW] = QUOTE_LENGTH_RANGES[o.quoteLength];
  const styleLine =
    o.imageStyle === "auto"
      ? "Choose the most fitting style for each quote from the allowed enum, varying styles across the batch where sensible."
      : `Use style "${o.imageStyle}" for every item.`;
  return `Create ${n} distinct Pinterest quote pins.
Topic / keywords from the user: "${o.topic}"
Language for quote, title and description: ${o.language}
Emotional tone: ${o.tone}
Quote length: ${minW}-${maxW} words each.
${styleLine}
For each item return: topic (short sub-topic label, e.g. "Broken trust"), emotion (one word), quote, title (max 100 chars, SEO-friendly), description (150-500 chars, natural keywords, optionally at most 3 relevant hashtags at the end), keywords (3-8 search phrases), alt_text (max 400 chars, describes the image and the quote's meaning), style, background_prompt.
${avoid.length ? `Do NOT repeat or paraphrase any of these existing quotes:\n${avoid.map((q) => `- ${q}`).join("\n")}` : ""}
Return JSON: {"items":[...]}`;
}

export class QuoteService {
  constructor(private provider: TextProvider) {}

  private validLength(q: string, len: QuoteLength) {
    const [minW, maxW] = QUOTE_LENGTH_RANGES[len];
    const w = wordCount(q);
    return w >= Math.max(3, minW - 3) && w <= maxW + 6;
  }

  /** Returns true if `candidate` is a near-duplicate of anything in `pool`. */
  isLexicalDuplicate(candidate: string, pool: string[]): boolean {
    return pool.some((p) => lexicalSimilarity(candidate, p) >= LEXICAL_DUP_THRESHOLD);
  }

  private async semanticFilter(cands: QuoteItem[], pool: string[]): Promise<QuoteItem[]> {
    if (!this.provider.embed || cands.length === 0) return cands;
    try {
      const recentPool = pool.slice(0, 200);
      const vecs = await this.provider.embed([...cands.map((c) => c.quote), ...recentPool]);
      const candVecs = vecs.slice(0, cands.length);
      const poolVecs = vecs.slice(cands.length);
      const kept: { item: QuoteItem; vec: number[] }[] = [];
      cands.forEach((item, i) => {
        const v = candVecs[i];
        if (!v || v.length === 0) return void kept.push({ item, vec: [] });
        const dupPool = poolVecs.some((p) => cosine(v, p) >= SEMANTIC_DUP_THRESHOLD);
        const dupBatch = kept.some((k) => k.vec.length && cosine(v, k.vec) >= SEMANTIC_DUP_THRESHOLD);
        if (!dupPool && !dupBatch) kept.push({ item, vec: v });
      });
      return kept.map((k) => k.item);
    } catch (e) {
      // Embeddings are a best-effort extra layer; lexical checks still apply.
      logger.warn({ err: e }, "Semantic duplicate check unavailable");
      return cands;
    }
  }

  private sanitize(item: QuoteItem, o: QuoteGenerationOptions): QuoteItem {
    const style = o.imageStyle !== "auto" ? o.imageStyle : isImageStyle(item.style) ? item.style : "dark_cinematic";
    const seo = normalizeSeo(item);
    return { ...item, ...seo, quote: cleanQuote(item.quote), style };
  }

  /**
   * Generates up to `count` unique quote items. Regenerates only the missing/duplicate slots.
   * May return fewer than `count` if the model keeps producing duplicates (caller handles partial batches).
   */
  async generateBatch(o: QuoteGenerationOptions): Promise<QuoteItem[]> {
    const accepted: QuoteItem[] = [];
    const pool = [...o.existingQuotes];
    for (let round = 0; round < 3 && accepted.length < o.count; round++) {
      const need = o.count - accepted.length;
      const ask = Math.min(need + (round === 0 ? 2 : 1), 12);
      const avoid = [...accepted.map((a) => a.quote), ...pool].slice(0, 60);
      const res = await this.provider.generateJson({
        task: "quotes",
        input: { ...o, count: ask, avoid },
        system: SYSTEM,
        prompt: buildPrompt(o, ask, avoid),
        schema: QuoteBatchSchema,
        temperature: 1.0,
      });
      let cands = res.items.map((i) => this.sanitize(i, o)).filter((i) => this.validLength(i.quote, o.quoteLength));
      cands = cands.filter((c, idx) => {
        const others = [...pool, ...accepted.map((a) => a.quote), ...cands.slice(0, idx).map((x) => x.quote)];
        return !this.isLexicalDuplicate(c.quote, others);
      });
      cands = await this.semanticFilter(cands, [...accepted.map((a) => a.quote), ...pool]);
      accepted.push(...cands.slice(0, need));
      logger.debug({ round, accepted: accepted.length, wanted: o.count }, "Quote generation round");
    }
    return accepted;
  }

  /** Writes a single new quote for an existing pin (keeps topic), avoiding all given quotes. */
  async rewriteOne(o: Omit<QuoteGenerationOptions, "count">): Promise<QuoteItem> {
    const items = await this.generateBatch({ ...o, count: 1 });
    if (!items[0]) throw new Error("Could not generate a sufficiently unique quote; try a different angle.");
    return items[0];
  }
}
