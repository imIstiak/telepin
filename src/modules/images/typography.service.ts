import path from "node:path";
import sharp from "sharp";
import { escapeMarkup } from "../../utils/text";
import { TYPOGRAPHY_PRESETS, type TypographyPreset } from "./styles";

export const FONT_DIR = path.resolve(__dirname, "..", "..", "..", "assets", "fonts");

export interface TextLayout {
  buffer: Buffer; // RGBA PNG of the rendered text block
  width: number;
  height: number;
  fontSize: number;
  /** Wrap width that produced this layout (re-use it to reproduce identical line breaks). */
  boxWidth: number;
}

export interface LayoutOptions {
  text: string;
  preset: TypographyPreset;
  color: string;
  maxWidth: number;
  maxHeight: number;
  minFontSize?: number;
  maxFontSize?: number;
  align?: "left" | "centre" | "right";
  /** Extra tracking as a fraction of the font size (e.g. 0.15 for spaced-out caps). */
  letterSpacing?: number;
  /** Override the preset's line spacing multiplier. */
  lineSpacing?: number;
  /** Balance line lengths (default true). */
  balance?: boolean;
}

async function renderAt(o: LayoutOptions, size: number): Promise<TextLayout> {
  const p: { file: string; family: string; lineSpacing: number; letterSpacing?: number } = TYPOGRAPHY_PRESETS[o.preset];
  const tracking = o.letterSpacing ?? p.letterSpacing ?? 0;
  const ls = tracking ? ` letter_spacing="${Math.round(size * tracking * 1024)}"` : "";
  const markup = `<span foreground="${o.color}"${ls}>${escapeMarkup(o.text)}</span>`;
  const { data, info } = await sharp({
    text: {
      text: markup,
      font: `${p.family} ${size}`,
      fontfile: path.join(FONT_DIR, p.file),
      width: o.maxWidth,
      align: o.align ?? "centre",
      justify: false,
      dpi: 72,
      rgba: true,
      wrap: "word",
      spacing: Math.round(size * ((o.lineSpacing ?? p.lineSpacing) - 1)),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, fontSize: size, boxWidth: o.maxWidth };
}

/**
 * Finds the largest font size whose *actually rendered* text block (measured by Pango) fits the box.
 * Uses binary search over integer sizes; throws if the text can't fit even at the minimum size.
 */
export async function layoutText(o: LayoutOptions): Promise<TextLayout> {
  let lo = o.minFontSize ?? 30;
  let hi = o.maxFontSize ?? 92;
  let best: TextLayout | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await renderAt(o, mid);
    if (r.width <= o.maxWidth && r.height <= o.maxHeight) {
      best = r;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) throw new TextOverflowError(`Quote is too long to fit the image at the minimum font size`);
  return o.balance === false ? best : balanceLines(o, best);
}

/**
 * Avoids ragged layouts and single-word last lines ("orphans"): narrows the text box while the
 * line count stays the same, so lines come out similar in length.
 */
async function balanceLines(o: LayoutOptions, base: TextLayout): Promise<TextLayout> {
  let best = base;
  const minWidth = Math.round(o.maxWidth * 0.55);
  for (let w = o.maxWidth - 24; w >= minWidth; w -= 24) {
    const r = await renderAt({ ...o, maxWidth: w }, base.fontSize);
    if (r.height > base.height || r.width > w) break;
    best = r;
  }
  return best;
}

/** Suggested max font size so short quotes don't become billboard-sized. */
export function maxFontSizeFor(text: string, preset: TypographyPreset): number {
  const words = text.trim().split(/\s+/).length;
  // Editorial sizing: generous but never billboard-like; long quotes get smaller, calmer type.
  const base = words <= 6 ? 76 : words <= 12 ? 64 : words <= 20 ? 56 : words <= 30 ? 48 : 42;
  return Math.round(base * TYPOGRAPHY_PRESETS[preset].sizeScale);
}

export class TextOverflowError extends Error {}
