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

/** Renders at an exact size and wrap width (use a layout's fontSize + boxWidth to reproduce identical line breaks). */
export async function renderAt(o: LayoutOptions, size: number): Promise<TextLayout> {
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
    // Wrap slightly inside the box: italic overhang can make Pango's block a few px wider than the wrap width,
    // which would otherwise make the size search non-monotonic and pick a needlessly small font.
    const pad = Math.ceil(mid * 0.12);
    const r = await renderAt({ ...o, maxWidth: o.maxWidth - pad }, mid);
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
  for (let w = base.boxWidth - 24; w >= minWidth; w -= 24) {
    const r = await renderAt({ ...o, maxWidth: w }, base.fontSize);
    if (r.height > base.height || r.width > o.maxWidth) break;
    best = r;
  }
  return best;
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Style system V2 sizing (Cormorant-equivalent px, scaled per typeface):
 * ≤8 words 94–110px · 9–18 words 75–94px · 19–30 words 60–75px · longer quotes 48–60px.
 * Within a band, more words → smaller ceiling, so lines stay balanced and calm.
 */
export function fontBandFor(text: string): { min: number; max: number } {
  const w = wordCount(text);
  if (w <= 8) return { min: 94, max: Math.round(110 - Math.max(0, w - 3) * 3) };
  if (w <= 18) return { min: 75, max: Math.round(94 - (w - 9) * 1.5) };
  if (w <= 30) return { min: 60, max: Math.round(75 - (w - 19) * 1.0) };
  return { min: 48, max: 60 };
}

export function maxFontSizeFor(text: string, preset: TypographyPreset): number {
  return Math.round(fontBandFor(text).max * TYPOGRAPHY_PRESETS[preset].sizeScale);
}

/** Lowest size we accept before shrinking further into the next band; never below 40px. */
export function minFontSizeFor(text: string, preset: TypographyPreset): number {
  return Math.max(40, Math.round((fontBandFor(text).min - 30) * TYPOGRAPHY_PRESETS[preset].sizeScale));
}

export class TextOverflowError extends Error {}
