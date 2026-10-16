import sharp, { type OverlayOptions } from "sharp";
import { isLightStyle, type ImageStyle, type TypographyPreset } from "./styles";
import { layoutText, maxFontSizeFor } from "./typography.service";

export const PIN_WIDTH = 1000;
export const PIN_HEIGHT = 1500;
export const MARGIN_X = 90;

export interface RenderOptions {
  background: Buffer;
  quote: string;
  style: ImageStyle;
  typography: TypographyPreset;
  watermark?: string | null;
  quality?: number;
}

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  fontSize: number;
  textColor: string;
}

/** Fits any background to 1000x1500 (2:3), cropping toward the most interesting region. */
export async function prepareBackground(input: Buffer): Promise<Buffer> {
  return sharp(input).rotate().resize(PIN_WIDTH, PIN_HEIGHT, { fit: "cover", position: sharp.strategy.attention }).removeAlpha().png().toBuffer();
}

/** Mean relative luminance (0..1) of the central text region. */
async function regionLuminance(bg: Buffer): Promise<number> {
  const { data } = await sharp(bg)
    .extract({ left: MARGIN_X, top: Math.round(PIN_HEIGHT * 0.25), width: PIN_WIDTH - 2 * MARGIN_X, height: Math.round(PIN_HEIGHT * 0.5) })
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 3) {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    sum += 0.2126 * lin(data[i]!) + 0.7152 * lin(data[i + 1]!) + 0.0722 * lin(data[i + 2]!);
  }
  return sum / (data.length / 3);
}

function overlaySvg(dark: boolean, strength: number): Buffer {
  // A soft vertical scrim behind the text block, strongest in the middle.
  const c = dark ? "#000000" : "#ffffff";
  const a = strength.toFixed(2);
  const mid = (strength * 1.15).toFixed(2);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${c}" stop-opacity="${(strength * 0.35).toFixed(2)}"/>
    <stop offset=".3" stop-color="${c}" stop-opacity="${a}"/>
    <stop offset=".5" stop-color="${c}" stop-opacity="${mid}"/>
    <stop offset=".7" stop-color="${c}" stop-opacity="${a}"/>
    <stop offset="1" stop-color="${c}" stop-opacity="${(strength * 0.5).toFixed(2)}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#s)"/>
</svg>`);
}

function dividerSvg(color: string, y: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}">
  <line x1="${PIN_WIDTH / 2 - 40}" y1="${y}" x2="${PIN_WIDTH / 2 + 40}" y2="${y}" stroke="${color}" stroke-opacity=".7" stroke-width="2"/>
</svg>`);
}

export async function renderQuoteImage(o: RenderOptions): Promise<RenderResult> {
  const bg = await prepareBackground(o.background);
  const lum = await regionLuminance(bg);
  // Light text on dark scenes; dark text on light scenes. Style hint breaks ties near the middle.
  const lightBg = lum > 0.42 || (lum > 0.3 && isLightStyle(o.style));
  const textColor = lightBg ? "#1c1a17" : "#fbf8f3";
  const shadowColor = lightBg ? "#ffffff" : "#000000";
  // Stronger scrim the closer the background is to the text colour.
  const contrastGap = lightBg ? lum : 1 - lum;
  const scrim = Math.min(0.55, Math.max(0.12, 0.75 - contrastGap * 0.8));

  const maxWidth = PIN_WIDTH - 2 * MARGIN_X;
  const maxHeight = Math.round(PIN_HEIGHT * 0.6);
  const text = await layoutText({
    text: o.quote,
    preset: o.typography,
    color: textColor,
    maxWidth,
    maxHeight,
    maxFontSize: maxFontSizeFor(o.quote, o.typography),
  });
  const shadow = await layoutText({
    text: o.quote,
    preset: o.typography,
    color: shadowColor,
    maxWidth,
    maxHeight,
    minFontSize: text.fontSize,
    maxFontSize: text.fontSize,
  });
  const shadowBlurred = await sharp(shadow.buffer).blur(8).ensureAlpha(0.55).png().toBuffer();

  const left = Math.round((PIN_WIDTH - text.width) / 2);
  const top = Math.round((PIN_HEIGHT - text.height) / 2) - 20;

  const layers: OverlayOptions[] = [
    { input: overlaySvg(!lightBg, scrim), top: 0, left: 0 },
    { input: shadowBlurred, top: top + 3, left: left + 2, blend: "over" },
    { input: text.buffer, top, left },
    { input: dividerSvg(textColor, Math.min(PIN_HEIGHT - 160, top + text.height + 60)), top: 0, left: 0 },
  ];

  if (o.watermark?.trim()) {
    const wm = await layoutText({
      text: o.watermark.trim().slice(0, 40),
      preset: "light_sans",
      color: textColor,
      maxWidth: 600,
      maxHeight: 60,
      minFontSize: 18,
      maxFontSize: 26,
    });
    layers.push({ input: await sharp(wm.buffer).ensureAlpha().png().toBuffer(), top: PIN_HEIGHT - 70 - wm.height, left: Math.round((PIN_WIDTH - wm.width) / 2) });
  }

  const buffer = await sharp(bg)
    .composite(layers)
    .jpeg({ quality: o.quality ?? 88, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width!, height: meta.height!, mimeType: "image/jpeg", fontSize: text.fontSize, textColor };
}
