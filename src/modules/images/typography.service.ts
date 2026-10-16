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
}

async function renderAt(o: LayoutOptions, size: number): Promise<TextLayout> {
  const p = TYPOGRAPHY_PRESETS[o.preset];
  const markup = `<span foreground="${o.color}">${escapeMarkup(o.text)}</span>`;
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
      spacing: Math.round(size * (p.lineSpacing - 1)),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, fontSize: size };
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
  return best;
}

/** Suggested max font size so short quotes don't become billboard-sized. */
export function maxFontSizeFor(text: string, preset: TypographyPreset): number {
  const words = text.trim().split(/\s+/).length;
  const base = words <= 8 ? 88 : words <= 14 ? 76 : words <= 22 ? 64 : 54;
  return preset === "handwritten" ? base + 10 : preset.includes("sans") ? base - 6 : base;
}

export class TextOverflowError extends Error {}
