export const IMAGE_STYLES = {
  dark_cinematic: {
    label: "Dark cinematic",
    prompt: "dark cinematic scene, deep shadows, soft film grain, dramatic low-key lighting, muted teal and charcoal tones",
    palette: ["#0b0d12", "#1b2330", "#2f3b4c"],
  },
  rainy_window: {
    label: "Rainy window",
    prompt: "raindrops on a window glass at night, blurred city bokeh lights behind, melancholic mood, cool blue tones",
    palette: ["#0e1622", "#24364a", "#4a6278"],
  },
  lonely_silhouette: {
    label: "Lonely silhouette",
    prompt: "a lonely silhouette of a person seen from behind in the distance, foggy atmosphere, wide empty space, cinematic",
    palette: ["#14151a", "#3a3f4a", "#7b8190"],
  },
  minimal_black: {
    label: "Minimal black",
    prompt: "minimal matte black textured background with subtle soft light falloff, elegant and clean",
    palette: ["#050505", "#111111", "#1f1f1f"],
  },
  beige_editorial: {
    label: "Beige editorial",
    prompt: "warm beige editorial background, soft linen texture, natural daylight shadows of leaves, calm aesthetic",
    palette: ["#e9dfd1", "#d8c8b2", "#c2ad92"],
  },
  vintage_paper: {
    label: "Vintage paper",
    prompt: "aged vintage paper texture, subtle stains and fibers, warm sepia tones, soft vignette",
    palette: ["#efe3c8", "#d9c49c", "#b89b6c"],
  },
  soft_romantic: {
    label: "Soft romantic",
    prompt: "soft romantic pastel scene, dried roses out of focus, blush pink and cream tones, dreamy light",
    palette: ["#f3d9dc", "#e3b5bd", "#c98f9c"],
  },
  moody_blue: {
    label: "Moody blue",
    prompt: "moody deep blue atmosphere, ocean at dusk, misty, quiet and sad, cinematic color grading",
    palette: ["#0a1426", "#163055", "#2f5585"],
  },
  sunset_aesthetic: {
    label: "Sunset aesthetic",
    prompt: "golden hour sunset sky, warm orange and lavender gradient, gentle clouds, nostalgic aesthetic",
    palette: ["#2d1b3d", "#b05a6a", "#f2a65a"],
  },
  minimal_typography: {
    label: "Minimal typography",
    prompt: "very minimal plain background with a soft subtle gradient and fine paper grain, lots of empty space",
    palette: ["#f4f1ec", "#e7e2da", "#d6cfc4"],
  },
} as const;

export type ImageStyle = keyof typeof IMAGE_STYLES;
export const IMAGE_STYLE_KEYS = Object.keys(IMAGE_STYLES) as ImageStyle[];

export function isImageStyle(s: unknown): s is ImageStyle {
  return typeof s === "string" && s in IMAGE_STYLES;
}

/** Light backgrounds need dark text. */
export function isLightStyle(style: ImageStyle): boolean {
  return ["beige_editorial", "vintage_paper", "soft_romantic", "minimal_typography"].includes(style);
}

export function buildBackgroundPrompt(style: ImageStyle, sceneHint?: string | null): string {
  const s = IMAGE_STYLES[style];
  const scene = sceneHint?.trim() ? `${sceneHint.trim().replace(/\.$/, "")}. ` : "";
  return (
    `${scene}Style: ${s.prompt}. Vertical 2:3 Pinterest composition with a large calm area of negative space ` +
    `in the center for overlaid text. Photographic, high quality, aesthetic. ` +
    `Absolutely no text, no letters, no words, no typography, no logos, no watermarks, no signatures.`
  );
}

export const TYPOGRAPHY_PRESETS = {
  elegant_serif: { label: "Elegant serif", file: "PlayfairDisplay_500Medium.ttf", family: "Playfair Display Medium", lineSpacing: 1.18 },
  serif_italic: { label: "Serif italic", file: "PlayfairDisplay_400Regular_Italic.ttf", family: "Playfair Display Italic", lineSpacing: 1.2 },
  book_serif: { label: "Book serif", file: "Lora_400Regular.ttf", family: "Lora", lineSpacing: 1.25 },
  modern_sans: { label: "Modern sans", file: "Montserrat_500Medium.ttf", family: "Montserrat Medium", lineSpacing: 1.22 },
  light_sans: { label: "Light sans", file: "Montserrat_300Light.ttf", family: "Montserrat Light", lineSpacing: 1.25 },
  handwritten: { label: "Handwritten", file: "DancingScript_600SemiBold.ttf", family: "Dancing Script SemiBold", lineSpacing: 1.1 },
} as const;

export type TypographyPreset = keyof typeof TYPOGRAPHY_PRESETS;
export const TYPOGRAPHY_KEYS = Object.keys(TYPOGRAPHY_PRESETS) as TypographyPreset[];
export function isTypographyPreset(s: unknown): s is TypographyPreset {
  return typeof s === "string" && s in TYPOGRAPHY_PRESETS;
}
