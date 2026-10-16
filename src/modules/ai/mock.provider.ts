import sharp from "sharp";
import type { ImageProvider, JsonGenerationRequest, TextProvider } from "./provider.interface";

/**
 * Deterministic offline provider for tests and local development without API keys.
 * It is NOT a content generator for production; quotes come from a small fixed bank.
 */
const BANK = [
  "You taught me that not every promise is meant to be kept.",
  "I stopped waiting for an apology and started healing without one.",
  "Some people leave quietly, and the silence they leave is the loudest thing I own.",
  "Trust broke slowly, then all at once, like glass under a heavy word.",
  "I loved you in a language you never cared to learn.",
  "Letting go was the kindest thing I ever did for my own heart.",
  "The night still remembers the version of me who believed you.",
  "My heart is not closed, it is simply learning to choose better.",
  "I miss who I thought you were, not who you turned out to be.",
  "Healing is not forgetting; it is remembering without bleeding.",
  "You were my favorite chapter, but not the ending I deserved.",
  "I gave you the truth and you handed me lessons instead.",
];

export class MockTextProvider implements TextProvider {
  readonly name = "mock";
  private cursor = 0;
  /** Override per test to return custom payloads. */
  handlers: Partial<Record<string, (req: JsonGenerationRequest<unknown>) => unknown>> = {};

  async generateJson<T>(req: JsonGenerationRequest<T>): Promise<T> {
    const custom = this.handlers[req.task];
    const raw = custom ? custom(req as JsonGenerationRequest<unknown>) : this.defaultFor(req);
    return req.schema.parse(raw);
  }

  private defaultFor(req: JsonGenerationRequest<unknown>): unknown {
    const input = req.input ?? {};
    const topic = String(input.topic ?? "heartbreak");
    if (req.task === "quotes" || req.task === "rewrite_quote") {
      const n = Number(input.count ?? 1);
      const style = input.imageStyle && input.imageStyle !== "auto" ? String(input.imageStyle) : "rainy_window";
      const items = Array.from({ length: n }, () => {
        const quote = BANK[this.cursor++ % BANK.length]!;
        return {
          topic: topic.slice(0, 40),
          emotion: "sad",
          quote,
          title: `Sad Quotes About ${topic.slice(0, 40)}`,
          description: `Emotional quotes about ${topic}, heartbreak and healing after a difficult relationship. Save this for later.`,
          keywords: [`${topic} quotes`, "heartbreak quotes", "healing quotes"],
          alt_text: `An emotional quote about ${topic} over a moody background.`,
          style,
          background_prompt: "Rainy window at night, blurred city lights, moody, no text.",
        };
      });
      return { items };
    }
    if (req.task === "seo") {
      return {
        title: `Quotes About ${topic}`,
        description: `A meaningful quote about ${topic} for anyone healing and moving forward. Save it for later.`,
        keywords: [`${topic} quotes`, "life lessons"],
        alt_text: `Quote about ${topic} on an aesthetic background.`,
      };
    }
    if (req.task === "board_scores") {
      const pins = (input.pins as { n: number; text: string }[]) ?? [];
      const boards = (input.boards as { n: number; text: string }[]) ?? [];
      return {
        pins: pins.map((p) => ({
          pin: p.n,
          scores: boards.map((b) => ({ board: b.n, score: keywordScore(p.text, b.text) })),
          reason: "keyword overlap (mock)",
        })),
      };
    }
    throw new Error(`MockTextProvider has no handler for ${req.task}`);
  }
}

const GENERIC = new Set(["quote", "saying", "word", "aesthetic", "idea", "pin", "the", "and", "for", "about"]);

/** Deterministic relevance score used when AI board scoring is unavailable. */
export function keywordScore(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2)
        .map((w) => w.replace(/(ing|ed|s)$/, ""))
        .filter((w) => !GENERIC.has(w)),
    );
  const A = words(a);
  const B = words(b);
  let hit = 0;
  for (const w of B) if (A.has(w)) hit++;
  return B.size ? Math.min(100, Math.round((hit / B.size) * 100)) : 0;
}

/** Procedural backgrounds (gradient + vignette + grain). No AI, no text. */
export class GradientImageProvider implements ImageProvider {
  readonly name: string = "gradient";
  constructor(private palettes: Record<string, readonly string[]> = {}) {}

  async generateBackground(_prompt: string, opts: { seed?: number; style: string }): Promise<Buffer> {
    const pal = this.palettes[opts.style] ?? ["#101218", "#283142", "#56627a"];
    const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
    const angle = seed % 360;
    const cx = 30 + (seed % 40);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)">
      <stop offset="0" stop-color="${pal[0]}"/><stop offset=".55" stop-color="${pal[1]}"/><stop offset="1" stop-color="${pal[2]}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${cx}%" cy="35%" r="60%">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="v" cx="50%" cy="50%" r="75%">
      <stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/>
    </radialGradient>
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="${seed % 1000}"/><feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 .07 0"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect width="100%" height="100%" filter="url(#n)"/>
  <rect width="100%" height="100%" fill="url(#v)"/>
</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}

export class MockImageProvider extends GradientImageProvider {
  override readonly name = "mock";
}
