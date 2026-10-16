import { clampText } from "../../utils/text";
import type { TextProvider } from "./provider.interface";
import { PINTEREST_LIMITS, SeoSchema, type SeoMetadata } from "./schemas";

/** Enforce Pinterest limits and tidy keywords. */
export function normalizeSeo<T extends SeoMetadata>(m: T): T {
  const seen = new Set<string>();
  const keywords = m.keywords
    .map((k) => k.trim().replace(/^#/, "").toLowerCase())
    .filter((k) => k && !seen.has(k) && (seen.add(k), true))
    .slice(0, 8);
  // Cap hashtags to avoid overuse.
  let hashtags = 0;
  const description = m.description.replace(/#[\p{L}\p{N}_]+/gu, (h) => (++hashtags <= 3 ? h : "")).replace(/\s{2,}/g, " ");
  return {
    ...m,
    title: clampText(m.title.replace(/\s+/g, " "), PINTEREST_LIMITS.title),
    description: clampText(description, PINTEREST_LIMITS.description),
    alt_text: clampText(m.alt_text, PINTEREST_LIMITS.altText),
    keywords,
  };
}

export class SeoService {
  constructor(private provider: TextProvider) {}

  /** Generate fresh metadata for a (possibly user-edited) quote. */
  async generate(input: { quote: string; topic: string; language: string; style: string }): Promise<SeoMetadata> {
    const res = await this.provider.generateJson({
      task: "seo",
      input,
      system:
        "You write accurate, non-misleading Pinterest SEO metadata for quote image pins. Use keywords naturally; no keyword stuffing. Pinterest has no tags field.",
      prompt: `Quote: "${input.quote}"
Topic: ${input.topic}
Image style: ${input.style}
Language: ${input.language}
Return JSON {"title" (max 100 chars), "description" (150-500 chars, optionally up to 3 hashtags at the end), "keywords" (3-8 search phrases), "alt_text" (max 400 chars, describe the image and the quote)}.`,
      schema: SeoSchema,
      temperature: 0.7,
    });
    return normalizeSeo(res);
  }
}
