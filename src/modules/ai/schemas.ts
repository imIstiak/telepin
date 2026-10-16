import { z } from "zod";
import { IMAGE_STYLE_KEYS } from "../images/styles";

/** Current Pinterest API v5 limits for POST /pins (title 100, description 800, alt_text 500, link 2048). */
export const PINTEREST_LIMITS = { title: 100, description: 800, altText: 500, link: 2048 } as const;

export const QuoteItemSchema = z.object({
  topic: z.string().min(1).max(80),
  emotion: z.string().min(1).max(40),
  quote: z.string().min(5).max(400),
  title: z.string().min(5).max(160),
  description: z.string().min(20).max(1200),
  keywords: z.array(z.string().min(2).max(60)).min(2).max(12),
  alt_text: z.string().min(10).max(700),
  style: z.enum(IMAGE_STYLE_KEYS as [string, ...string[]]),
  background_prompt: z.string().min(10).max(600),
});
export type QuoteItem = z.infer<typeof QuoteItemSchema>;

export const QuoteBatchSchema = z.object({ items: z.array(QuoteItemSchema).min(1).max(15) });

export const SeoSchema = z.object({
  title: z.string().min(5).max(160),
  description: z.string().min(20).max(1200),
  keywords: z.array(z.string().min(2).max(60)).min(2).max(12),
  alt_text: z.string().min(10).max(700),
});
export type SeoMetadata = z.infer<typeof SeoSchema>;

export const BoardScoresSchema = z.object({
  pins: z.array(
    z.object({
      pin: z.number().int().min(1),
      scores: z.array(z.object({ board: z.number().int().min(1), score: z.number().min(0).max(100) })),
      reason: z.string().max(200),
    }),
  ),
});
export type BoardScores = z.infer<typeof BoardScoresSchema>;
