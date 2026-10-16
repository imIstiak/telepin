/* Renders sample pins over a few photo-like synthetic scenes to ./samples (no AI calls). */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderQuoteImage } from "../src/modules/images/renderer.service";
import type { ImageStyle, TypographyPreset } from "../src/modules/images/styles";

const W = 1000;
const H = 1500;
const scene = (body: string, blur = 0) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`))
    .blur(blur || 0.3)
    .png()
    .toBuffer();

const rand = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const scenes: Record<string, () => Promise<Buffer>> = {
  // Beige wall with diagonal window-light shadows and a vase silhouette at the bottom.
  beige_window: () =>
    scene(
      `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efe4d4"/><stop offset="1" stop-color="#d3bfa6"/></linearGradient></defs>
       <rect width="100%" height="100%" fill="url(#a)"/>
       <g opacity=".22" fill="#6d5640" transform="skewX(-18) translate(300 -100)">${[0, 1, 2, 3].map((i) => `<rect x="${i * 150}" y="0" width="60" height="1700"/>`).join("")}</g>
       <rect y="1250" width="100%" height="250" fill="#c9b293"/>
       <path d="M640 1250 q-40 -120 10 -220 q50 100 10 220z" fill="#8a7259" opacity=".7"/>
       <path d="M655 1040 q-80 -140 -40 -260 M660 1040 q60 -150 120 -230" stroke="#6c5741" stroke-width="5" fill="none" opacity=".6"/>`,
      6,
    ),
  // Night window with blurred city bokeh.
  rainy_bokeh: () => {
    const r = rand(7);
    const dots = Array.from({ length: 70 }, () => `<circle cx="${r() * W}" cy="${r() * H}" r="${10 + r() * 45}" fill="${["#f4c27a", "#e98a5a", "#7fb2e6", "#f2e1b0"][Math.floor(r() * 4)]}" opacity="${0.25 + r() * 0.5}"/>`).join("");
    return scene(`<rect width="100%" height="100%" fill="#0f1726"/>${dots}`, 14);
  },
  // Moody sea at dusk.
  moody_sea: () =>
    scene(
      `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c2b45"/><stop offset=".55" stop-color="#46607f"/><stop offset=".56" stop-color="#22324a"/><stop offset="1" stop-color="#0d1624"/></linearGradient></defs>
       <rect width="100%" height="100%" fill="url(#s)"/><ellipse cx="520" cy="820" rx="260" ry="18" fill="#9fb3c8" opacity=".35"/>`,
      3,
    ),
  // Busy floral pattern (should trigger the frosted card).
  busy_floral: () => {
    const r = rand(42);
    const f = Array.from({ length: 220 }, () => `<circle cx="${r() * W}" cy="${r() * H}" r="${8 + r() * 30}" fill="${["#d98ba0", "#f3d5c0", "#7d9c6b", "#fbeee6", "#b85f7a"][Math.floor(r() * 5)]}"/>`).join("");
    return scene(`<rect width="100%" height="100%" fill="#e9c9c4"/>${f}`, 1.5);
  },
};

async function main() {
  await fs.mkdir("samples", { recursive: true });
  const runs: [string, ImageStyle, TypographyPreset, string][] = [
    ["beige_window", "beige_editorial", "elegant_serif", "I spent so long trying to hold us together that I forgot I was the one falling apart."],
    ["rainy_bokeh", "rainy_window", "classic_serif", "Some people leave quietly, and the silence they leave becomes the loudest thing I own."],
    ["moody_sea", "moody_blue", "serif_italic", "Healing is not forgetting; it is remembering without bleeding."],
    ["busy_floral", "soft_romantic", "elegant_serif", "My heart is not closed, it is simply learning to choose better."],
    ["beige_window", "beige_editorial", "display_thin", "Let it go."],
    ["moody_sea", "moody_blue", "light_sans", "You taught me that not every promise is meant to be kept."],
  ];
  let i = 0;
  for (const [sc, style, typo, quote] of runs) {
    const bg = await scenes[sc]!();
    const r = await renderQuoteImage({ background: bg, quote, style, typography: typo, watermark: "@thingsineversaid" });
    const name = `samples/${++i}-${sc}-${typo}.jpg`;
    await fs.writeFile(name, r.buffer);
    console.log(name, `font ${r.fontSize}px`, r.layout, r.zone, r.textColor);
  }
}
main();
