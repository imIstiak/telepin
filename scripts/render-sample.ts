/* Renders sample pins for every style/typography to ./samples (uses procedural backgrounds unless a real provider is configured). */
import fs from "node:fs/promises";
import { GradientImageProvider } from "../src/modules/ai/mock.provider";
import { renderQuoteImage } from "../src/modules/images/renderer.service";
import { IMAGE_STYLES, IMAGE_STYLE_KEYS, TYPOGRAPHY_KEYS } from "../src/modules/images/styles";

async function main() {
  await fs.mkdir("samples", { recursive: true });
  const provider = new GradientImageProvider(Object.fromEntries(Object.entries(IMAGE_STYLES).map(([k, v]) => [k, v.palette])));
  const quotes = [
    "You taught me that not every promise is meant to be kept.",
    "Some people leave quietly, and the silence they leave behind becomes the loudest thing in the room for a very long time.",
    "Let go.",
  ];
  let i = 0;
  for (const style of IMAGE_STYLE_KEYS) {
    const typography = TYPOGRAPHY_KEYS[i % TYPOGRAPHY_KEYS.length]!;
    const bg = await provider.generateBackground("", { style, seed: i * 97 });
    const r = await renderQuoteImage({ background: bg, quote: quotes[i % quotes.length]!, style, typography, watermark: "@yourbrand" });
    await fs.writeFile(`samples/${style}-${typography}.jpg`, r.buffer);
    console.log(style, typography, `${r.width}x${r.height}`, `font ${r.fontSize}px`, r.textColor);
    i++;
  }
}
main();
