/*
 * Style System V2 render test: 10 styles × 3 quotes (short / medium / long) = 30 pins in ./samples,
 * plus a contact sheet and a QA report. Uses synthetic, style-representative scenes (no AI calls, no cost).
 * Real Gemini backgrounds must be checked separately by generating a batch per style in Telegram.
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderQuoteImage } from "../src/modules/images/renderer.service";
import { IMAGE_STYLES, IMAGE_STYLE_KEYS, type ImageStyle } from "../src/modules/images/styles";

const W = 1000;
const H = 1500;
const rand = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const scene = (body: string, blur = 0.3) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`)).blur(blur).png().toBuffer();
const lg = (id: string, stops: [number, string][], vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
const flower = (x: number, y: number, r: number, c: string, c2: string) =>
  Array.from({ length: 6 }, (_, i) => `<ellipse cx="${x + Math.cos(i) * r * 0.6}" cy="${y + Math.sin(i) * r * 0.6}" rx="${r * 0.55}" ry="${r * 0.4}" fill="${c}" opacity=".85" transform="rotate(${i * 60} ${x} ${y})"/>`).join("") +
  `<circle cx="${x}" cy="${y}" r="${r * 0.3}" fill="${c2}"/>`;

const SCENES: Record<ImageStyle, () => Promise<Buffer>> = {
  soft_feminine_editorial: () =>
    scene(`<defs>${lg("a", [[0, "#FFF9F3"], [1, "#F1E4DD"]], false)}</defs><rect width="100%" height="100%" fill="url(#a)"/>
      <g opacity=".12" fill="#8a6a60" transform="skewX(-20) translate(500 0)"><rect x="0" width="70" height="1500"/><rect x="160" width="40" height="1500"/></g>
      ${flower(150, 1330, 90, "#E8C3C3", "#C99FA3")}${flower(300, 1420, 60, "#F1D9D9", "#C99FA3")}
      <path d="M180 1330 Q260 1150 230 1000" stroke="#9aa58d" stroke-width="6" fill="none"/>`, 3),
  rainy_window: () => {
    const r = rand(7);
    const bokeh = Array.from({ length: 60 }, () => `<circle cx="${r() * W}" cy="${900 + r() * 600}" r="${15 + r() * 50}" fill="${["#f4c27a", "#e0a060", "#7fb2e6", "#f2e1b0"][Math.floor(r() * 4)]}" opacity="${0.2 + r() * 0.45}"/>`).join("");
    const drops = Array.from({ length: 260 }, () => `<circle cx="${r() * W}" cy="${r() * H}" r="${1 + r() * 4}" fill="#cfe0f0" opacity="${0.15 + r() * 0.25}"/>`).join("");
    return scene(`<defs>${lg("a", [[0, "#0E1622"], [0.6, "#1a2a3c"], [1, "#24364A"]])}</defs><rect width="100%" height="100%" fill="url(#a)"/>${bokeh}${drops}`, 4);
  },
  vintage_paper: () => {
    const r = rand(3);
    const fibers = Array.from({ length: 160 }, () => `<line x1="${r() * W}" y1="${r() * H}" x2="${r() * W}" y2="${r() * H}" stroke="#b9a383" stroke-opacity=".06" stroke-width="1"/>`).join("");
    return scene(`<defs><radialGradient id="a" cx="50%" cy="45%" r="80%"><stop offset="0" stop-color="#EFE4D1"/><stop offset="1" stop-color="#D7C4A6"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#a)"/>${fibers}
      ${flower(850, 170, 55, "#C9A09A", "#8a6b55")}<path d="M850 170 Q760 300 700 330" stroke="#7f7457" stroke-width="4" fill="none"/>`, 1.2);
  },
  dreamy_sky: () =>
    scene(`<defs>${lg("a", [[0, "#C9BDE0"], [0.5, "#F3D4D9"], [1, "#F5D9BD"]])}</defs><rect width="100%" height="100%" fill="url(#a)"/>
      <ellipse cx="200" cy="200" rx="380" ry="90" fill="#fff" opacity=".35"/><ellipse cx="800" cy="1300" rx="420" ry="120" fill="#fff" opacity=".4"/><ellipse cx="600" cy="1200" rx="300" ry="70" fill="#f8e6ea" opacity=".5"/>`, 22),
  dark_romantic: () =>
    scene(`<defs><radialGradient id="a" cx="40%" cy="35%" r="85%"><stop offset="0" stop-color="#3a2228"/><stop offset="1" stop-color="#201A20"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#a)"/>
      <path d="M0 1250 Q400 1150 1000 1300 L1000 1500 L0 1500Z" fill="#54232E" opacity=".55"/>
      ${flower(800, 1330, 85, "#6e1f2e", "#3a0f18")}<path d="M800 1330 Q700 1430 560 1480" stroke="#2c3a2a" stroke-width="7" fill="none"/>`, 3),
  cozy_journal: () =>
    scene(`<rect width="100%" height="100%" fill="#D9C6AE"/><rect x="90" y="230" width="820" height="1040" rx="10" fill="#F5EBDD"/><line x1="500" y1="230" x2="500" y2="1270" stroke="#c9b597" stroke-width="5" opacity=".6"/>
      <circle cx="900" cy="110" r="120" fill="#efe6dc"/><circle cx="900" cy="110" r="85" fill="#8b6a52" opacity=".55"/>${flower(110, 1400, 55, "#c8a089", "#6B5549")}`, 2),
  minimal_typography: () =>
    scene(`<defs>${lg("a", [[0, "#FAF7F2"], [1, "#EFE7DC"]])}</defs><rect width="100%" height="100%" fill="url(#a)"/>`, 0.3),
  peaceful_ocean: () =>
    scene(`<defs>${lg("s", [[0, "#B6CBD0"], [0.66, "#DCE3E2"], [0.67, "#8fa7ae"], [1, "#647F89"]])}</defs><rect width="100%" height="100%" fill="url(#s)"/>
      ${Array.from({ length: 10 }, (_, i) => `<line x1="0" y1="${1030 + i * 45}" x2="1000" y2="${1030 + i * 45}" stroke="#eef3f3" stroke-opacity=".18" stroke-width="3"/>`).join("")}`, 2),
  golden_hour_lifestyle: () =>
    scene(`<defs>${lg("a", [[0, "#F7E6C9"], [1, "#DFC5A8"]], false)}</defs><rect width="100%" height="100%" fill="url(#a)"/>
      <g opacity=".22" fill="#fff8e8">${Array.from({ length: 6 }, (_, i) => `<rect x="${i * 170}" y="0" width="70" height="1500"/>`).join("")}</g>
      <rect y="1260" width="100%" height="240" fill="#efe2cf"/><path d="M0 1260 Q500 1200 1000 1260" fill="#e3d1b8"/>`, 6),
  misty_nature: () => {
    const r = rand(11);
    const trees = Array.from({ length: 14 }, (_, i) => {
      const left = i % 2 === 0;
      const x = left ? r() * 220 : 780 + r() * 220;
      const w = 18 + r() * 30;
      return `<rect x="${x}" y="0" width="${w}" height="1500" fill="#425548" opacity="${0.25 + r() * 0.5}"/>`;
    }).join("");
    return scene(`<defs>${lg("a", [[0, "#D8DDD5"], [1, "#A8B5A2"]])}</defs><rect width="100%" height="100%" fill="url(#a)"/>${trees}<rect width="100%" height="100%" fill="#D8DDD5" opacity=".35"/>`, 5);
  },
};

const QUOTES: Record<ImageStyle, [string, string, string]> = {
  soft_feminine_editorial: ["You are allowed to bloom slowly.", "Be gentle with yourself; you are learning to love the person you were always meant to be.", "One day you will look back and realise that every soft moment you gave yourself was the reason you finally began to heal, grow and trust your own heart again."],
  rainy_window: ["I still miss you on quiet nights.", "Some people leave quietly, and the silence they leave behind becomes the loudest thing I own.", "Rain keeps tapping on the glass like it knows the words I never said to you, and every night I almost answer it before I remember you are gone."],
  vintage_paper: ["Some letters are never sent.", "I kept every word you never said, folded neatly between the pages of who I used to be.", "Memories are strange keepsakes; they fade at the edges, but the moments that broke us open are the ones that never quite lose their colour."],
  dreamy_sky: ["Tomorrow is a softer sky.", "Healing is not a race; it is learning to breathe beneath an open sky again.", "There will be a morning when the weight feels lighter, the light feels warmer, and you will realise that hope quietly stayed with you the entire time."],
  dark_romantic: ["You broke what you promised.", "I trusted you with everything I had, and you taught me how heavy silence can be.", "The cruelest part of betrayal is not the lie itself but how long I defended you to my own heart before I finally believed what I already knew."],
  cozy_journal: ["Today, I choose slow.", "I am learning that overthinking is just my heart trying to protect a version of me that no longer exists.", "Some mornings I write down everything I am grateful for, and slowly the list becomes longer than the worries I carried into bed the night before."],
  minimal_typography: ["Protect your peace.", "You don't have to explain your boundaries to people who benefit from you having none.", "Self-respect means walking away from anything that asks you to shrink, even when part of you still wishes it could have been the place you belonged."],
  peaceful_ocean: ["Let it go, gently.", "Acceptance is the quiet tide that carries away what we were never meant to hold.", "Like the ocean returning to stillness after every wave, I am learning that letting go is not losing; it is finally making room for peace to arrive."],
  golden_hour_lifestyle: ["Good things are coming.", "Gratitude turns ordinary afternoons into the moments you will someday call home.", "Happiness was never a grand arrival; it was warm light on the bedroom wall, a slow cup of tea, and the quiet feeling that I am exactly where I need to be."],
  misty_nature: ["Grow quietly.", "Like the forest after the fog, I am still here, still growing, still finding my way.", "Resilience is not loud; it is the quiet decision to keep growing roots in the dark, trusting that the light will find you when the mist finally lifts."],
};

async function main() {
  await fs.mkdir("samples", { recursive: true });
  for (const f of await fs.readdir("samples")) await fs.unlink(`samples/${f}`);
  const rows: string[] = [];
  const thumbs: { input: Buffer; left: number; top: number }[] = [];
  let failures = 0;
  let i = 0;
  for (const style of IMAGE_STYLE_KEYS) {
    const bg = await SCENES[style]();
    for (const [qi, quote] of QUOTES[style].entries()) {
      const r = await renderQuoteImage({ background: bg, quote, style });
      const name = `${String(++i).padStart(2, "0")}-${style}-${["short", "medium", "long"][qi]}.jpg`;
      await fs.writeFile(`samples/${name}`, r.buffer);
      if (!r.qa.passed) failures++;
      rows.push(
        `| ${name} | ${IMAGE_STYLES[style].label} | ${quote.split(/\s+/).length} | ${r.typography} ${r.fontSize}px | ${r.region} | ${r.textColor} | ${r.layout}${r.veilStrength ? ` ${r.veilStrength}` : ""} | ${r.qa.contrast} / ${r.qa.worstContrast} | ${r.qa.passed ? "PASS" : "FAIL"} |`,
      );
      const col = (i - 1) % 6;
      const row = Math.floor((i - 1) / 6);
      thumbs.push({ input: await sharp(r.buffer).resize(200, 300).toBuffer(), left: col * 210 + 10, top: row * 310 + 10 });
      console.log(name, r.fontSize, r.region, r.textColor, r.layout, r.qa.contrast, r.qa.passed ? "PASS" : "FAIL");
    }
  }
  const rowsCount = Math.ceil(i / 6);
  await sharp({ create: { width: 6 * 210 + 10, height: rowsCount * 310 + 10, channels: 3, background: "#ffffff" } })
    .composite(thumbs)
    .jpeg({ quality: 88 })
    .toFile("samples/contact-sheet.jpg");
  const report = [
    "# Style System V2 — render test",
    "",
    `${i} images · ${i - failures} passed QA · ${failures} failed`,
    "",
    "QA per image: 1000×1500, 2:3, valid sRGB JPEG (q91), exact quote, no clipping, safe margins (110px), WCAG contrast ≥4.5 (avg) and ≥2.6 (darkest/brightest 10% of pixels), no branding/ornaments.",
    "Backgrounds here are synthetic stand-ins for each style; real Gemini output must be checked by generating one batch per style.",
    "",
    "| File | Style | Words | Type | Region | Text | Layout | Contrast avg / worst | QA |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  await fs.writeFile("samples/REPORT.md", report);
  console.log(`\n${i - failures}/${i} passed`);
}
main();
