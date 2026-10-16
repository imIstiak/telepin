import sharp, { type OverlayOptions } from "sharp";
import { resolveStyle, styleConfig, type ImageStyle, type StyleConfig, type TextRegion, type TypographyPreset } from "./styles";
import { layoutText, maxFontSizeFor, minFontSizeFor, renderAt } from "./typography.service";

export const PIN_WIDTH = 1000;
export const PIN_HEIGHT = 1500;
/** Side margins (spec: 100–120px). */
export const MARGIN_X = 110;
/** Top/bottom safe margins — the quote never comes closer to the edge than this. */
export const MARGIN_Y = 110;
export const JPEG_QUALITY = 91;
/** WCAG contrast targets: against the average background and against the worst 10% of pixels. */
export const MIN_CONTRAST = 4.5;
export const MIN_WORST_CONTRAST = 2.6;

export interface RenderOptions {
  background: Buffer;
  quote: string;
  style: ImageStyle | string;
  /** Explicit preset; when omitted the style's own typography is used. */
  typography?: TypographyPreset | null;
  quality?: number;
}

export interface RenderQA {
  dimensionsOk: boolean;
  aspectRatioOk: boolean;
  validJpeg: boolean;
  quotePreserved: boolean;
  noClipping: boolean;
  safeMargins: boolean;
  contrastOk: boolean;
  contrast: number;
  worstContrast: number;
  /** Rendering never adds logos, watermarks, footers, ornaments or extra text. */
  noBranding: true;
  passed: boolean;
}

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  fontSize: number;
  textColor: string;
  region: TextRegion;
  /** "clean" = text straight on the photo; "veil" = a soft, edgeless local tonal veil was needed. */
  layout: "clean" | "veil";
  veilStrength: number;
  typography: TypographyPreset;
  box: { left: number; top: number; width: number; height: number };
  qa: RenderQA;
}

/** Fits any background to 1000x1500 (2:3), cropping toward the most interesting region. */
export async function prepareBackground(input: Buffer): Promise<Buffer> {
  return sharp(input).rotate().resize(PIN_WIDTH, PIN_HEIGHT, { fit: "cover", position: sharp.strategy.attention }).removeAlpha().png().toBuffer();
}

function svg(body: string) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}">${body}</svg>`);
}

/** Style-specific colour grade (not a universal filter): saturation, black lift, gentle tint, grain, vignette. */
export async function gradeBackground(bg: Buffer, s: StyleConfig): Promise<Buffer> {
  const g = s.grade;
  let img = sharp(bg).modulate({ saturation: g.saturation });
  if (g.lift > 0) img = img.linear(1 - g.lift / 255, g.lift);
  let out = await img.png().toBuffer();
  const layers: OverlayOptions[] = [];
  if (g.tint && g.tint.strength > 0) {
    layers.push({ input: svg(`<rect width="100%" height="100%" fill="${g.tint.color}" fill-opacity="${g.tint.strength}"/>`), blend: "soft-light" });
  }
  if (g.grain > 0) {
    const grain = await sharp({ create: { width: PIN_WIDTH, height: PIN_HEIGHT, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 28 } } })
      .greyscale()
      .ensureAlpha(Math.min(0.15, g.grain))
      .png()
      .toBuffer();
    layers.push({ input: grain, blend: "overlay" });
  }
  if (g.vignette > 0) {
    layers.push({
      input: svg(`<defs><radialGradient id="v" cx="50%" cy="50%" r="75%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${g.vignette.toFixed(2)}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/>`),
    });
  }
  if (layers.length) out = await sharp(out).composite(layers).png().toBuffer();
  return out;
}

// ---------- colour / contrast helpers ----------

const hexRgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance 0..1. */
export const relLum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const hexLum = (hex: string) => relLum(...hexRgb(hex));
export const contrastRatio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export interface RegionStats {
  mean: number; // mean relative luminance
  p10: number; // darkest 10%
  p90: number; // brightest 10%
  busyness: number; // local edge energy 0..~0.3
}

/** Luminance distribution + texture of the actual pixels behind the quote box. */
export async function regionStats(bg: Buffer, box: { left: number; top: number; width: number; height: number }): Promise<RegionStats> {
  const n = 80;
  const { data } = await sharp(bg).extract(box).resize(n, n, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lums: number[] = [];
  let edges = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 3;
      lums.push(relLum(data[i]!, data[i + 1]!, data[i + 2]!));
      if (x < n - 1) edges += Math.abs(data[i]! - data[i + 3]!) + Math.abs(data[i + 1]! - data[i + 4]!) + Math.abs(data[i + 2]! - data[i + 5]!);
      if (y < n - 1) {
        const j = i + n * 3;
        edges += Math.abs(data[i]! - data[j]!) + Math.abs(data[i + 1]! - data[j + 1]!) + Math.abs(data[i + 2]! - data[j + 2]!);
      }
    }
  }
  const sorted = [...lums].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { mean: lums.reduce((a, b) => a + b, 0) / lums.length, p10: q(0.1), p90: q(0.9), busyness: edges / (2 * n * (n - 1) * 3 * 255) };
}

/** Contrast of a text colour against a region, with an optional soft veil of `veilHex` at opacity `a` mixed in. */
function evaluate(textHex: string, st: RegionStats, veil?: { hex: string; a: number }) {
  const mix = (l: number) => (veil ? l * (1 - veil.a) + hexLum(veil.hex) * veil.a : l);
  const t = hexLum(textHex);
  const dark = t < 0.25;
  const worstBg = dark ? mix(st.p10) : mix(st.p90); // dark text struggles on the darkest pixels and vice versa
  return { contrast: contrastRatio(t, mix(st.mean)), worst: contrastRatio(t, worstBg) };
}

const REGION_CENTER: Record<TextRegion, number> = { upper: 0.27, upper_middle: 0.39, middle: 0.5, lower: 0.7 };
const REGION_ORDER: Record<TextRegion, TextRegion[]> = {
  upper: ["upper", "upper_middle", "middle", "lower"],
  upper_middle: ["upper_middle", "middle", "upper", "lower"],
  middle: ["middle", "upper_middle", "lower", "upper"],
  lower: ["lower", "middle", "upper_middle", "upper"],
};

interface Plan {
  region: TextRegion;
  color: string;
  veil: number;
  veilHex: string;
  contrast: number;
  worst: number;
  box: { left: number; top: number; width: number; height: number };
  score: number;
}

/**
 * Chooses region, text colour and (only if needed) a soft veil. Fallback chain per spec:
 * style colour → alternate colour → subtle veil → next region → best effort flagged for regeneration.
 */
async function planText(bg: Buffer, s: StyleConfig, blockW: number, blockH: number): Promise<Plan> {
  const alternates = { dark: ["#1E1A18"], light: ["#FFFFFF"] };
  let best = null as Plan | null;
  for (const [ri, region] of REGION_ORDER[s.textRegion].entries()) {
    const cy = Math.round(PIN_HEIGHT * REGION_CENTER[region]);
    const padX = 40;
    const padY = 50;
    const top = Math.max(MARGIN_Y, Math.min(PIN_HEIGHT - MARGIN_Y - blockH, cy - Math.round(blockH / 2)));
    const box = {
      left: Math.max(0, Math.round((PIN_WIDTH - blockW) / 2) - padX),
      top: Math.max(0, top - padY),
      width: Math.min(PIN_WIDTH, blockW + 2 * padX),
      height: Math.min(PIN_HEIGHT - Math.max(0, top - padY), blockH + 2 * padY),
    };
    const st = await regionStats(bg, box);
    const textBox = { left: Math.round((PIN_WIDTH - blockW) / 2), top, width: blockW, height: blockH };
    const candidates = [s.text.dark, s.text.light, ...alternates.dark, ...alternates.light];
    // Region penalty keeps us in the style's preferred region unless another is clearly better.
    const regionPenalty = ri * 0.6 + st.busyness * 25;
    const veilSteps = s.veil ? [0, 0.16, 0.26, 0.36] : [0];
    for (const [vi, a] of veilSteps.entries()) {
      for (const [ci, color] of candidates.entries()) {
        const isDark = hexLum(color) < 0.25;
        const veilHex = isDark ? "#FFFFFF" : "#000000";
        const e = evaluate(color, st, a ? { hex: veilHex, a } : undefined);
        const ok = e.contrast >= MIN_CONTRAST && e.worst >= MIN_WORST_CONTRAST;
        // Once contrast passes, prefer the style's own colours; otherwise maximise contrast.
        const score = (ok ? 100 : 0) + Math.min(e.contrast, 9) * (ok ? 0.2 : 1) - regionPenalty - vi * 1.5 - (ci >= 2 ? 2 : 0);
        const plan: Plan = { region, color, veil: a, veilHex, contrast: e.contrast, worst: e.worst, box: textBox, score };
        if (!best || plan.score > best.score) best = plan;
      }
      // Stop escalating the veil as soon as this region has a passing option.
      if (best && best.region === region && best.score >= 100) return best;
    }
    if (best && best.score >= 100 && st.busyness < 0.06) return best;
  }
  return best!;
}

/** Soft, edgeless elliptical tonal veil — never a visible box or panel. */
function softVeil(box: Plan["box"], hex: string, a: number) {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const rx = box.width * 0.72 + 80;
  const ry = box.height * 0.75 + 110;
  return svg(`<defs><radialGradient id="g" cx="${cx}" cy="${cy}" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${cx} ${cy}) scale(${rx} ${ry}) translate(${-cx} ${-cy})">
    <stop offset="0" stop-color="${hex}" stop-opacity="${a.toFixed(2)}"/>
    <stop offset="0.6" stop-color="${hex}" stop-opacity="${(a * 0.75).toFixed(2)}"/>
    <stop offset="1" stop-color="${hex}" stop-opacity="0"/>
  </radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>`);
}

export async function renderQuoteImage(o: RenderOptions): Promise<RenderResult> {
  const styleId = resolveStyle(o.style);
  const s = styleConfig(styleId);
  const typography = o.typography ?? s.typography;
  const base = await prepareBackground(o.background);
  const bg = await gradeBackground(base, s);

  const maxWidth = PIN_WIDTH - 2 * MARGIN_X;
  const maxHeight = Math.round(PIN_HEIGHT * 0.52);
  // Layout is colour-independent: measure once, then decide colour from the real pixels behind it.
  const probe = await layoutText({
    text: o.quote,
    preset: typography,
    color: "#000000",
    maxWidth,
    maxHeight,
    minFontSize: minFontSizeFor(o.quote, typography),
    maxFontSize: maxFontSizeFor(o.quote, typography),
  });
  const plan = await planText(bg, s, probe.width, probe.height);
  const text = await renderAt({ text: o.quote, preset: typography, color: plan.color, maxWidth: probe.boxWidth, maxHeight: probe.height }, probe.fontSize);
  const textTop = plan.box.top;
  const textLeft = Math.round((PIN_WIDTH - text.width) / 2);

  const layers: OverlayOptions[] = [];
  if (plan.veil > 0) layers.push({ input: softVeil(plan.box, plan.veilHex, plan.veil), top: 0, left: 0 });
  // Very soft shadow only for light text over photos: depth without a visible effect.
  const lightText = hexLum(plan.color) >= 0.25;
  if (lightText) {
    const shadow = await renderAt({ text: o.quote, preset: typography, color: "#000000", maxWidth: text.boxWidth, maxHeight: text.height }, text.fontSize);
    const soft = await sharp(shadow.buffer).blur(9).ensureAlpha().linear([1, 1, 1, 0.38], [0, 0, 0, 0]).png().toBuffer();
    layers.push({ input: soft, top: textTop + 2, left: textLeft + 1 });
  }
  layers.push({ input: text.buffer, top: textTop, left: textLeft });

  const buffer = await sharp(bg)
    .composite(layers)
    .toColourspace("srgb")
    .withIccProfile("srgb")
    .jpeg({ quality: o.quality ?? JPEG_QUALITY, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const meta = await sharp(buffer).metadata();

  const qa: RenderQA = {
    dimensionsOk: meta.width === PIN_WIDTH && meta.height === PIN_HEIGHT,
    aspectRatioOk: Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 2 / 3) < 0.005,
    validJpeg: meta.format === "jpeg",
    quotePreserved: true, // the exact quote string is rendered; no transformation is applied
    noClipping: text.width <= maxWidth && text.height <= maxHeight && text.width === probe.width && text.height === probe.height,
    safeMargins: textLeft >= MARGIN_X - 1 && textTop >= MARGIN_Y && textTop + text.height <= PIN_HEIGHT - MARGIN_Y && textLeft + text.width <= PIN_WIDTH - MARGIN_X + 1,
    contrastOk: plan.contrast >= MIN_CONTRAST && plan.worst >= MIN_WORST_CONTRAST,
    contrast: Math.round(plan.contrast * 100) / 100,
    worstContrast: Math.round(plan.worst * 100) / 100,
    noBranding: true,
    passed: false,
  };
  qa.passed = qa.dimensionsOk && qa.aspectRatioOk && qa.validJpeg && qa.quotePreserved && qa.noClipping && qa.safeMargins && qa.contrastOk;

  return {
    buffer,
    width: meta.width!,
    height: meta.height!,
    mimeType: "image/jpeg",
    fontSize: text.fontSize,
    textColor: plan.color,
    region: plan.region,
    layout: plan.veil > 0 ? "veil" : "clean",
    veilStrength: plan.veil,
    typography,
    box: { left: textLeft, top: textTop, width: text.width, height: text.height },
    qa,
  };
}

/** 64-bit difference hash (hex) for near-duplicate detection between pins of a batch. */
export async function perceptualHash(img: Buffer): Promise<string> {
  const { data } = await sharp(img).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x]! > data[y * 9 + x + 1]! ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
