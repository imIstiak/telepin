import sharp, { type OverlayOptions } from "sharp";
import { isLightStyle, type ImageStyle, type TypographyPreset } from "./styles";
import { layoutText, maxFontSizeFor } from "./typography.service";

export const PIN_WIDTH = 1000;
export const PIN_HEIGHT = 1500;
/** Generous side margins: editorial pins breathe. */
export const MARGIN_X = 140;

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
  layout: "clean" | "frosted";
  zone: "upper" | "middle" | "lower";
}

/** Fits any background to 1000x1500 (2:3), cropping toward the most interesting region. */
export async function prepareBackground(input: Buffer): Promise<Buffer> {
  return sharp(input).rotate().resize(PIN_WIDTH, PIN_HEIGHT, { fit: "cover", position: sharp.strategy.attention }).removeAlpha().png().toBuffer();
}

/** Matte film grade: slightly lifted blacks, softer saturation, fine grain. Makes AI images feel less "digital". */
async function filmGrade(bg: Buffer): Promise<Buffer> {
  const graded = await sharp(bg).modulate({ saturation: 0.86, brightness: 1.0 }).linear(0.93, 10).png().toBuffer();
  const grain = await sharp({ create: { width: PIN_WIDTH, height: PIN_HEIGHT, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 28 } } })
    .greyscale()
    .png()
    .toBuffer();
  const grainAlpha = await sharp(grain).ensureAlpha(0.07).png().toBuffer();
  return sharp(graded).composite([{ input: grainAlpha, blend: "overlay" }]).png().toBuffer();
}

/** Above this local-contrast level, text sits on a frosted card instead of directly on the photo. */
export const BUSY_THRESHOLD = 0.013;

type Zone = "upper" | "middle" | "lower";
const ZONES: Record<Zone, { top: number; height: number }> = {
  upper: { top: 150, height: 560 },
  middle: { top: 470, height: 560 },
  lower: { top: 790, height: 560 },
};

interface RegionStats {
  luminance: number; // 0..1
  busyness: number; // stdev of luminance 0..~0.5
}

async function regionStats(bg: Buffer, top: number, height: number): Promise<RegionStats> {
  const { data } = await sharp(bg)
    .extract({ left: MARGIN_X - 40, top, width: PIN_WIDTH - 2 * (MARGIN_X - 40), height })
    .resize(96, 96, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Luminance mean, plus "busyness" = average local colour change between neighbouring pixels
  // (catches patterned/cluttered areas even when overall brightness is uniform).
  let lum = 0;
  let edges = 0;
  const px = (i: number) => [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 3;
      const [r, g, b] = px(i);
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (x < 95) {
        const [r2, g2, b2] = px(i + 3);
        edges += Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2);
      }
      if (y < 95) {
        const [r3, g3, b3] = px(i + 96 * 3);
        edges += Math.abs(r - r3) + Math.abs(g - g3) + Math.abs(b - b3);
      }
    }
  }
  return { luminance: lum / (96 * 96 * 255), busyness: edges / (2 * 96 * 95 * 3 * 255) };
}

/** Picks the calmest band for the text (prefers the middle unless it's clearly busier). */
async function chooseZone(bg: Buffer): Promise<{ zone: Zone; stats: RegionStats }> {
  const entries = await Promise.all((Object.keys(ZONES) as Zone[]).map(async (z) => [z, await regionStats(bg, ZONES[z].top, ZONES[z].height)] as const));
  const middle = entries.find(([z]) => z === "middle")!;
  const calmest = entries.reduce((a, b) => (b[1].busyness < a[1].busyness ? b : a));
  const pick = calmest[1].busyness * 1.6 + 0.005 < middle[1].busyness ? calmest : middle;
  return { zone: pick[0], stats: pick[1] };
}

function svg(body: string) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}">${body}</svg>`);
}

/** Soft elliptical glow behind the text: lifts contrast without a visible box. */
function softScrim(cx: number, cy: number, rx: number, ry: number, dark: boolean, strength: number) {
  const c = dark ? "#000000" : "#ffffff";
  return svg(`<defs><radialGradient id="g" cx="${cx}" cy="${cy}" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${cx} ${cy}) scale(${rx} ${ry}) translate(${-cx} ${-cy})">
    <stop offset="0" stop-color="${c}" stop-opacity="${strength.toFixed(2)}"/>
    <stop offset="0.55" stop-color="${c}" stop-opacity="${(strength * 0.6).toFixed(2)}"/>
    <stop offset="1" stop-color="${c}" stop-opacity="0"/>
  </radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>`);
}

/** Gentle edge vignette for depth. */
function vignette(strength: number) {
  return svg(`<defs><radialGradient id="v" cx="50%" cy="50%" r="75%">
    <stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${strength.toFixed(2)}"/>
  </radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/>`);
}

/** Frosted-glass card for busy backgrounds: blurred copy of the image inside a rounded rectangle. */
async function frostedCard(bg: Buffer, box: { left: number; top: number; width: number; height: number }, dark: boolean) {
  const radius = 28;
  const blurred = await sharp(bg)
    .extract(box)
    .blur(22)
    .modulate({ brightness: dark ? 0.82 : 1.1 })
    .png()
    .toBuffer();
  const tint = dark ? "#000000" : "#ffffff";
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}"><rect width="100%" height="100%" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
  const card = await sharp(blurred)
    .composite([
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}"><rect width="100%" height="100%" fill="${tint}" fill-opacity="${dark ? 0.22 : 0.28}"/></svg>`) },
      { input: mask, blend: "dest-in" },
    ])
    .png()
    .toBuffer();
  const border = svg(
    `<rect x="${box.left + 0.5}" y="${box.top + 0.5}" width="${box.width - 1}" height="${box.height - 1}" rx="${radius}" ry="${radius}" fill="none" stroke="${dark ? "#ffffff" : "#000000"}" stroke-opacity="0.14" stroke-width="1.5"/>`,
  );
  return [
    { input: card, top: box.top, left: box.left },
    { input: border, top: 0, left: 0 },
  ] as OverlayOptions[];
}

export async function renderQuoteImage(o: RenderOptions): Promise<RenderResult> {
  const base = await prepareBackground(o.background);
  const bg = await filmGrade(base);
  const { zone, stats } = await chooseZone(bg);

  // Light text on dark/mid scenes, dark text on bright scenes.
  const lightBg = stats.luminance > 0.58 || (stats.luminance > 0.46 && isLightStyle(o.style));
  const textColor = lightBg ? "#2a2420" : "#f7f1e8";
  const accent = lightBg ? "#2a2420" : "#f7f1e8";
  const layout: "clean" | "frosted" = stats.busyness > BUSY_THRESHOLD ? "frosted" : "clean";

  const maxWidth = PIN_WIDTH - 2 * MARGIN_X;
  const z = ZONES[zone];
  const text = await layoutText({
    text: o.quote,
    preset: o.typography,
    color: textColor,
    maxWidth,
    maxHeight: z.height - 170,
    minFontSize: 28,
    maxFontSize: maxFontSizeFor(o.quote, o.typography),
  });

  // Decorative opening quote mark in the same face, faded and trimmed to the glyph itself.
  const markPreset = o.typography === "handwritten" || o.typography === "display_thin" ? "elegant_serif" : o.typography;
  const markSize = Math.round(text.fontSize * 2.1);
  const mark = await layoutText({ text: "“", preset: markPreset, color: accent, maxWidth: 300, maxHeight: 600, minFontSize: markSize, maxFontSize: markSize, balance: false });
  const markTrim = await sharp(mark.buffer).trim({ threshold: 1 }).ensureAlpha().linear([1, 1, 1, 0.42], [0, 0, 0, 0]).png().toBuffer({ resolveWithObject: true });

  const gapMark = Math.round(text.fontSize * 0.55);
  const dividerGap = Math.round(text.fontSize * 0.7);
  const blockHeight = markTrim.info.height + gapMark + text.height + dividerGap + 2;
  const blockTop = Math.round(z.top + (z.height - blockHeight) / 2);
  const markTop = blockTop;
  const textTop = blockTop + markTrim.info.height + gapMark;
  const textLeft = Math.round((PIN_WIDTH - text.width) / 2);
  const dividerY = textTop + text.height + dividerGap;

  const layers: OverlayOptions[] = [{ input: vignette(lightBg ? 0.18 : 0.38), top: 0, left: 0 }];

  if (layout === "frosted") {
    const padX = 64;
    const padY = 56;
    const cardWidth = Math.min(PIN_WIDTH - 80, Math.max(text.width, 300) + padX * 2);
    const box = {
      left: Math.round((PIN_WIDTH - cardWidth) / 2),
      top: Math.max(40, blockTop - padY),
      width: cardWidth,
      height: Math.min(PIN_HEIGHT - 80, blockHeight + padY * 2),
    };
    layers.push(...(await frostedCard(bg, box, !lightBg)));
  } else {
    // Contrast need: how close the background is to the text colour.
    const gap = lightBg ? stats.luminance : 1 - stats.luminance;
    const strength = Math.min(0.5, Math.max(0.12, 0.62 - gap * 0.6));
    layers.push({ input: softScrim(PIN_WIDTH / 2, textTop + text.height / 2, maxWidth * 0.78, text.height * 0.95 + 120, !lightBg, strength), top: 0, left: 0 });
  }

  // Soft shadow only for light text on photos.
  if (!lightBg) {
    const shadow = await layoutText({ text: o.quote, preset: o.typography, color: "#000000", maxWidth: text.boxWidth, maxHeight: z.height, minFontSize: text.fontSize, maxFontSize: text.fontSize, balance: false });
    const soft = await sharp(shadow.buffer).blur(10).ensureAlpha().linear([1, 1, 1, 0.45], [0, 0, 0, 0]).png().toBuffer();
    layers.push({ input: soft, top: textTop + 2, left: textLeft + 1 });
  }

  layers.push({ input: markTrim.data, top: Math.max(0, markTop), left: Math.round((PIN_WIDTH - markTrim.info.width) / 2) });
  layers.push({ input: text.buffer, top: textTop, left: textLeft });
  layers.push({
    input: svg(`<line x1="${PIN_WIDTH / 2 - 28}" y1="${dividerY}" x2="${PIN_WIDTH / 2 + 28}" y2="${dividerY}" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.5"/>`),
    top: 0,
    left: 0,
  });

  if (o.watermark?.trim()) {
    const wm = await layoutText({
      balance: false,
      text: o.watermark.trim().slice(0, 40).toUpperCase(),
      preset: "light_sans",
      color: accent,
      maxWidth: 700,
      maxHeight: 50,
      minFontSize: 16,
      maxFontSize: 18,
      letterSpacing: 0.28,
    });
    const wmFaded = await sharp(wm.buffer).ensureAlpha().linear([1, 1, 1, 0.75], [0, 0, 0, 0]).png().toBuffer();
    layers.push({ input: wmFaded, top: PIN_HEIGHT - 72 - wm.height, left: Math.round((PIN_WIDTH - wm.width) / 2) });
  }

  const buffer = await sharp(bg)
    .composite(layers)
    .jpeg({ quality: o.quality ?? 90, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width!, height: meta.height!, mimeType: "image/jpeg", fontSize: text.fontSize, textColor, layout, zone };
}
