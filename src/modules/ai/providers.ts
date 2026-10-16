import { env } from "../../config/env";
import { IMAGE_STYLES } from "../images/styles";
import { GeminiImageProvider, GeminiTextProvider } from "./gemini.provider";
import { GradientImageProvider, MockImageProvider, MockTextProvider } from "./mock.provider";
import type { ImageProvider, TextProvider } from "./provider.interface";

const palettes = Object.fromEntries(Object.entries(IMAGE_STYLES).map(([k, v]) => [k, v.fallback]));

let text: TextProvider | undefined;
let image: ImageProvider | undefined;

export function getTextProvider(): TextProvider {
  if (!text) text = env.AI_TEXT_PROVIDER === "mock" ? new MockTextProvider() : new GeminiTextProvider();
  return text;
}

export function getImageProvider(): ImageProvider {
  if (!image) {
    image =
      env.AI_IMAGE_PROVIDER === "mock"
        ? new MockImageProvider(palettes)
        : env.AI_IMAGE_PROVIDER === "gradient"
          ? new GradientImageProvider(palettes)
          : new GeminiImageProvider();
  }
  return image;
}

/** Test hook. */
export function setProviders(p: { text?: TextProvider; image?: ImageProvider }) {
  if (p.text) text = p.text;
  if (p.image) image = p.image;
}

export function gradientFallback(): ImageProvider {
  return new GradientImageProvider(palettes);
}
