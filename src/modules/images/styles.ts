/**
 * Image style system V2 — 10 configuration-driven visual styles.
 * All style-specific behaviour (prompting, palette, typography, text placement, grading) lives here so the
 * pipeline and renderer stay style-agnostic.
 */

export const STYLE_SYSTEM_VERSION = 2;

export type TextRegion = "upper" | "upper_middle" | "middle" | "lower";

export interface StyleGrade {
  /** Saturation multiplier (1 = unchanged). */
  saturation: number;
  /** Film grain strength 0..1 (0 = none). */
  grain: number;
  /** Lift blacks (matte look) 0..30. */
  lift: number;
  /** Optional colour tint applied very gently (e.g. sepia warmth). */
  tint?: { color: string; strength: number };
  /** Edge vignette opacity 0..0.5. */
  vignette: number;
}

export interface StyleConfig {
  id: string;
  label: string;
  emoji: string;
  mood: string;
  themes: string[];
  /** Style-specific visual description (sent first). */
  prompt: string;
  lighting: string;
  palettePrompt: string;
  composition: string;
  /** Extra negative constraints on top of the global ones. */
  avoid: string;
  /** Natural variation pools; one entry of each is chosen per pin. */
  variations: { light: string[]; framing: string[]; material: string[] };
  palette: Record<string, string>;
  /** Fallback procedural background gradient (top → bottom). */
  fallback: [string, string, string];
  textRegion: TextRegion;
  typography: TypographyPreset;
  /** Foreground colours: dark text for light backgrounds, light text for dark backgrounds. */
  text: { dark: string; light: string };
  /** Soft local veil allowed when contrast is insufficient (no hard panels anywhere). */
  veil: boolean;
  grade: StyleGrade;
}

export const IMAGE_STYLES = {
  soft_feminine_editorial: {
    id: "soft_feminine_editorial",
    label: "Soft Feminine Editorial",
    emoji: "🌸",
    mood: "Romantic, graceful, gentle, emotionally comforting",
    themes: ["self-love", "self-worth", "healing", "gentle reminders"],
    prompt:
      "High-end soft feminine editorial still-life photography, delicate blush pink rose or small dried floral arrangement, warm ivory matte paper or fine linen backdrop, sophisticated muted romantic tones, understated photographic depth, elegant minimal arrangement, decorative details confined to corners or edges, realistic natural textures, premium art direction",
    lighting: "soft diffused morning light with subtle botanical shadows",
    palettePrompt: "ivory, cream, blush pink, dusty rose accents",
    composition: "flowers only at the edges or lower corners, no objects in the centre, gentle open composition with a large clean central negative space",
    avoid: "neon pink, artificial-looking roses, glitter, excessively decorative backgrounds",
    variations: {
      light: ["light falling from the upper left", "light falling from the right", "very soft overhead window light"],
      framing: ["single rose in the lower left corner", "small dried bouquet at the lower right edge", "petals and a stem entering from the bottom edge"],
      material: ["ivory matte paper", "fine natural linen", "cream cotton-paper card"],
    },
    palette: { ivory: "#F8F4EE", cream: "#FFF9F3", blush: "#F1D9D9", dustyRose: "#C99FA3", deepBrown: "#493A36" },
    fallback: ["#FFF9F3", "#F8F4EE", "#F1D9D9"],
    textRegion: "middle",
    typography: "elegant_serif",
    text: { dark: "#493A36", light: "#FFF9F3" },
    veil: true,
    grade: { saturation: 0.97, grain: 0.02, lift: 4, vignette: 0.05 },
  },
  rainy_window: {
    id: "rainy_window",
    label: "Rainy Window",
    emoji: "🌧",
    mood: "Melancholic, lonely, nostalgic, cinematic",
    themes: ["heartbreak", "missing someone", "loneliness", "silent feelings"],
    prompt:
      "Cinematic photograph of rain droplets on window glass at dusk or night, distant city lights rendered as soft defocused bokeh, realistic wet-glass textures, intimate melancholic atmosphere, shallow depth of field, subdued reflections, premium analog photography aesthetic",
    lighting: "soft cinematic low light with gentle glow from distant lights",
    palettePrompt: "atmospheric cool navy and desaturated blue with a few warm amber highlights",
    composition: "rain texture strongest near the edges, distant blurred lights, a smooth shadowed quiet region across the middle for typography",
    avoid: "bright neon lights, sharp readable city signs, cluttered reflections",
    variations: {
      light: ["late dusk blue hour", "deep night", "rainy evening with a faint warm streetlight"],
      framing: ["bokeh lights concentrated low in the frame", "a few large soft bokeh circles near the top corners", "streaks of rain down the left side"],
      material: ["fine droplets on clear glass", "larger rain beads and trickles", "fogged glass edges with droplets"],
    },
    palette: { midnightNavy: "#0E1622", slateBlue: "#24364A", stormBlue: "#4A6278", warmIvory: "#F7F1E8" },
    fallback: ["#0E1622", "#24364A", "#4A6278"],
    textRegion: "middle",
    typography: "classic_serif",
    text: { dark: "#0E1622", light: "#F7F1E8" },
    veil: true,
    grade: { saturation: 0.9, grain: 0.07, lift: 6, vignette: 0.22 },
  },
  vintage_paper: {
    id: "vintage_paper",
    label: "Vintage Paper",
    emoji: "📜",
    mood: "Nostalgic, poetic, personal, timeless",
    themes: ["memories", "lost love", "unsaid words", "reflections"],
    prompt:
      "Premium vintage stationery editorial still life, warm cream handmade parchment paper, subtle natural paper fibers, one delicate pressed dried flower near the edge, understated antique atmosphere, tactile realistic paper texture, beautifully restrained composition",
    lighting: "soft warm daylight",
    palettePrompt: "parchment, aged beige, faded rose, delicate sepia tonal variations",
    composition: "a broad clean central paper area for typography, the dried flower at a corner, light texture without stains in the centre",
    avoid: "heavy grunge, fake handwritten words, burnt edges, excessive stains, music sheets or printed text",
    variations: {
      light: ["warm light from the upper right", "even soft daylight", "late afternoon warm light from the left"],
      framing: ["pressed flower in the top right corner", "dried stem along the bottom edge", "small pressed petals in the lower left corner"],
      material: ["deckle-edged handmade paper", "smooth aged parchment", "cotton rag paper with visible fibers"],
    },
    palette: { parchment: "#EDE1CD", agedBeige: "#D7C4A6", fadedRose: "#B78F85", sepia: "#695447" },
    fallback: ["#EDE1CD", "#E4D5BC", "#D7C4A6"],
    textRegion: "middle",
    typography: "serif_italic",
    text: { dark: "#4A3A30", light: "#F5ECDD" },
    veil: false,
    grade: { saturation: 0.95, grain: 0.02, lift: 2, tint: { color: "#B07A45", strength: 0.05 }, vignette: 0.06 },
  },
  dreamy_sky: {
    id: "dreamy_sky",
    label: "Dreamy Sky",
    emoji: "☁️",
    mood: "Hopeful, ethereal, freeing, uplifting",
    themes: ["hope", "healing", "moving forward", "fresh beginnings"],
    prompt:
      "Dreamy atmospheric sky photography at a peaceful sunrise or sunset, soft layers of pastel clouds, gentle diffused glow, delicate atmospheric gradients, ethereal yet realistic sky, dreamy cinematic composition, tasteful editorial finish",
    lighting: "gentle diffused glow of the low sun",
    palettePrompt: "lavender, pale pink, peach, calm romantic colour harmony",
    composition: "expansive open sky, soft clouds framing the edges, a smooth tonal region for the quote",
    avoid: "highly saturated purple, surreal fantasy objects, harsh cloud patterns, birds, planes, sun disc behind the text",
    variations: {
      light: ["sunrise glow from below", "soft sunset afterglow", "overcast pastel dusk"],
      framing: ["wispy clouds near the top", "cloud bank along the bottom", "thin clouds drifting diagonally"],
      material: ["silky smooth gradients", "soft cotton-like clouds", "hazy layered sky"],
    },
    palette: { lavender: "#C9BDE0", palePink: "#F3D4D9", peach: "#F5D9BD", mauve: "#58485E" },
    fallback: ["#C9BDE0", "#F3D4D9", "#F5D9BD"],
    textRegion: "upper_middle",
    typography: "classic_serif",
    text: { dark: "#4A3D52", light: "#FFF8F4" },
    veil: true,
    grade: { saturation: 1.0, grain: 0.0, lift: 0, vignette: 0.0 },
  },
  dark_romantic: {
    id: "dark_romantic",
    label: "Dark Romantic",
    emoji: "🥀",
    mood: "Intense, emotional, mysterious, sophisticated",
    themes: ["betrayal", "heartbreak", "intense love", "painful memories"],
    prompt:
      "Premium dark romantic editorial still-life photograph, a single deep burgundy rose or restrained dark floral arrangement beside rich charcoal or muted wine-coloured fabric, realistic velvet textures, atmospheric dramatic shadows, sophisticated romantic depth, luxurious but minimalist composition",
    lighting: "elegant soft directional low-key lighting",
    palettePrompt: "deep wine, charcoal, muted rose",
    composition: "the single rose near an edge (bottom or a lower corner), balanced quiet dark negative space, nothing crossing the quote area",
    avoid: "horror imagery, gore, excessive red, gothic ornaments, crushed black shadows",
    variations: {
      light: ["key light from the left", "key light from the right", "soft top light"],
      framing: ["rose lying in the lower right corner", "rose stem rising from the bottom left", "petals scattered along the bottom edge"],
      material: ["charcoal velvet", "wine-coloured silk", "dark linen"],
    },
    palette: { deepWine: "#54232E", charcoal: "#201A20", mutedRose: "#98616C", warmIvory: "#F5E8DF" },
    fallback: ["#201A20", "#2E1C23", "#54232E"],
    textRegion: "upper_middle",
    typography: "classic_serif",
    text: { dark: "#201A20", light: "#F5E8DF" },
    veil: true,
    grade: { saturation: 0.95, grain: 0.04, lift: 8, vignette: 0.15 },
  },
  cozy_journal: {
    id: "cozy_journal",
    label: "Cozy Journal",
    emoji: "📖",
    mood: "Intimate, thoughtful, comforting, warm",
    themes: ["daily reflections", "overthinking", "personal growth", "gratitude"],
    prompt:
      "Cozy intimate editorial flat-lay photography, an open completely blank cream-coloured journal resting on soft linen, a delicate dried flower and a simple ceramic tea cup placed discreetly near the outer edges, warm tactile paper textures, subtle elegant shadows, peaceful reflective atmosphere, understated premium lifestyle aesthetic",
    lighting: "natural morning window light",
    palettePrompt: "warm cream, oatmeal, cocoa, muted taupe",
    composition: "the blank journal pages occupy the centre, accessories restricted to the edges, nothing crossing the pages",
    avoid: "any handwriting, printed text or lines on the pages, messy notebooks, pens crossing the centre, clutter",
    variations: {
      light: ["window light from the left", "window light from the top", "soft light with long gentle shadows"],
      framing: ["tea cup at the top right corner", "dried flower at the bottom left corner", "linen fold along the right edge"],
      material: ["oatmeal linen", "cream cotton tablecloth", "light oak table edge with linen"],
    },
    palette: { warmCream: "#F5EBDD", oatmeal: "#D9C6AE", cocoa: "#6B5549", mutedTaupe: "#B49B88" },
    fallback: ["#F5EBDD", "#EADCC8", "#D9C6AE"],
    textRegion: "middle",
    typography: "serif_italic",
    text: { dark: "#4E3D34", light: "#FBF4EA" },
    veil: true,
    grade: { saturation: 0.96, grain: 0.015, lift: 3, tint: { color: "#C49A6C", strength: 0.03 }, vignette: 0.06 },
  },
  minimal_typography: {
    id: "minimal_typography",
    label: "Minimal Typography",
    emoji: "🔤",
    mood: "Confident, clear, powerful, sophisticated",
    themes: ["boundaries", "self-respect", "affirmations", "strong reminders"],
    prompt:
      "Ultra-minimal premium editorial poster background, smooth warm ivory fine-art paper, almost imperceptible natural paper texture, very gentle sand-to-cream tonal variation, refined understated aesthetic, sophisticated print-design atmosphere, no props, no ornaments, no objects",
    lighting: "subtle soft even illumination",
    palettePrompt: "ivory and sand",
    composition: "almost entirely empty, a large completely clean central space",
    avoid: "objects, illustrations, symbols, frames, borders, strong gradients",
    variations: {
      light: ["very soft light from the top", "perfectly even light", "faint light falloff to the bottom"],
      framing: ["edge-to-edge paper", "edge-to-edge paper with the faintest corner shadow", "edge-to-edge paper"],
      material: ["cold-pressed watercolor paper", "smooth fine-art paper", "soft-grain cotton paper"],
    },
    palette: { ivory: "#FAF7F2", sand: "#E5DACD", charcoal: "#302B29", warmTaupe: "#9F8E82" },
    fallback: ["#FAF7F2", "#F2ECE3", "#E5DACD"],
    textRegion: "middle",
    typography: "classic_serif",
    text: { dark: "#302B29", light: "#FAF7F2" },
    veil: false,
    grade: { saturation: 1.0, grain: 0.0, lift: 0, vignette: 0.0 },
  },
  peaceful_ocean: {
    id: "peaceful_ocean",
    label: "Peaceful Ocean",
    emoji: "🌊",
    mood: "Calm, spacious, reflective, peaceful",
    themes: ["letting go", "acceptance", "healing", "inner peace"],
    prompt:
      "Minimal cinematic seascape photography, calm ocean at dawn, delicate soft waves, distant quiet horizon near the lower third, subtle atmospheric haze, realistic tranquil water textures, vast uncluttered open sky, peaceful high-end editorial composition",
    lighting: "gentle overcast coastal daylight",
    palettePrompt: "mist blue, sea slate, pale sand, deep blue-grey",
    composition: "horizon in the lower third, the open sky above as negative space for the quote, no foreground distractions",
    avoid: "storms, strong surf, crowded beaches, boats, people, birds",
    variations: {
      light: ["pale dawn haze", "soft overcast morning", "calm early evening haze"],
      framing: ["horizon at the lower third", "horizon slightly lower with more sky", "gentle shoreline at the very bottom"],
      material: ["glassy calm water", "soft rippled water", "faint foam lines on the water"],
    },
    palette: { mistBlue: "#B6CBD0", seaSlate: "#647F89", paleSand: "#EEE7DD", deepBlueGrey: "#344C55" },
    fallback: ["#B6CBD0", "#C9D6D8", "#647F89"],
    textRegion: "upper_middle",
    typography: "classic_serif",
    text: { dark: "#2E434B", light: "#F4F1EC" },
    veil: true,
    grade: { saturation: 0.95, grain: 0.02, lift: 3, vignette: 0.04 },
  },
  golden_hour_lifestyle: {
    id: "golden_hour_lifestyle",
    label: "Golden Hour Lifestyle",
    emoji: "🌅",
    mood: "Warm, optimistic, cozy, reassuring",
    themes: ["happiness", "gratitude", "comforting reminders", "new beginnings"],
    prompt:
      "Premium minimal lifestyle editorial photograph, soft late-afternoon sunlight passing through delicate white sheer curtains into a warm neutral bedroom or quiet interior, cream linen textures, gentle golden highlights, beautifully natural shadows, restrained cozy furniture details at the lower edge, intimate optimistic mood, realistic sophisticated composition",
    lighting: "soft late-afternoon golden sunlight",
    palettePrompt: "buttercream, warm beige, amber, cocoa brown",
    composition: "a clean neutral wall or translucent curtain area reserved for typography, furniture and bedding only near the bottom edge, no harsh sun bands across the centre",
    avoid: "busy interiors, exaggerated sun flares, oversaturated yellow, people",
    variations: {
      light: ["sunlight from the left window", "sunlight from the right window", "diffused golden light through curtains"],
      framing: ["bed linen along the bottom edge", "a small plant at the lower left corner", "an armchair edge at the lower right"],
      material: ["sheer white curtains", "cream plaster wall", "linen drapes"],
    },
    palette: { buttercream: "#F7E6C9", warmBeige: "#DFC5A8", amber: "#BE9167", cocoaBrown: "#594438" },
    fallback: ["#F7E6C9", "#EFD9B9", "#DFC5A8"],
    textRegion: "upper_middle",
    typography: "elegant_serif",
    text: { dark: "#4F3B2F", light: "#FFF8EC" },
    veil: true,
    grade: { saturation: 0.97, grain: 0.02, lift: 2, vignette: 0.05 },
  },
  misty_nature: {
    id: "misty_nature",
    label: "Misty Nature",
    emoji: "🌲",
    mood: "Quiet, thoughtful, grounding, restorative",
    themes: ["emotional growth", "acceptance", "resilience", "solitude"],
    prompt:
      "Atmospheric fine-art landscape photography of a quiet misty forest, soft sage-green trees dissolving into pale morning fog, subtle woodland pathway or distant natural depth, realistic foliage and fog textures, tree trunks framing the outer edges, serene contemplative editorial composition",
    lighting: "peaceful diffused overcast daylight",
    palettePrompt: "sage, fog white, muted forest green, grey-green",
    composition: "trees at the left and right edges, a foggy empty central region with clear tonal separation behind the text",
    avoid: "busy branches over the centre, fantasy lighting, intense green saturation, animals, people",
    variations: {
      light: ["thick morning fog", "light mist with soft depth", "overcast fog with faint sun glow"],
      framing: ["tall pines framing both sides", "a misty path fading into the distance", "birch trunks at the edges"],
      material: ["pine forest", "mixed deciduous woodland", "birch grove"],
    },
    palette: { sage: "#A8B5A2", fog: "#D8DDD5", forest: "#425548", mutedGreyGreen: "#788A7C" },
    fallback: ["#D8DDD5", "#C3CCBF", "#A8B5A2"],
    textRegion: "middle",
    typography: "classic_serif",
    text: { dark: "#33453A", light: "#F3F4EF" },
    veil: true,
    grade: { saturation: 0.92, grain: 0.03, lift: 4, vignette: 0.06 },
  },
} as const satisfies Record<string, StyleConfig>;

export type ImageStyle = keyof typeof IMAGE_STYLES;
export const IMAGE_STYLE_KEYS = Object.keys(IMAGE_STYLES) as ImageStyle[];

/** Style IDs from V1 that may still be stored on drafts/settings → their V2 equivalent. */
export const LEGACY_STYLE_MAP: Record<string, ImageStyle> = {
  dark_cinematic: "dark_romantic",
  lonely_silhouette: "misty_nature",
  minimal_black: "minimal_typography",
  beige_editorial: "soft_feminine_editorial",
  soft_romantic: "soft_feminine_editorial",
  moody_blue: "peaceful_ocean",
  sunset_aesthetic: "dreamy_sky",
};

export function isImageStyle(s: unknown): s is ImageStyle {
  return typeof s === "string" && s in IMAGE_STYLES;
}

/** Normalises any stored style value (V2 id, legacy V1 id or unknown) to a V2 style. */
export function resolveStyle(s: unknown, fallback: ImageStyle = "soft_feminine_editorial"): ImageStyle {
  if (isImageStyle(s)) return s;
  if (typeof s === "string" && LEGACY_STYLE_MAP[s]) return LEGACY_STYLE_MAP[s]!;
  return fallback;
}

export function styleConfig(s: unknown): StyleConfig {
  return IMAGE_STYLES[resolveStyle(s)];
}

/** Short catalogue used by the AI to pick a style semantically. */
export function styleCatalogForPrompt(): string {
  return IMAGE_STYLE_KEYS.map((k) => {
    const s = IMAGE_STYLES[k];
    return `- ${k}: ${s.label} — mood: ${s.mood}; best for: ${s.themes.join(", ")}`;
  }).join("\n");
}

/** Keyword hints used when the AI's style choice is missing/invalid (semantic choice by the model is preferred). */
const STYLE_KEYWORDS: Record<ImageStyle, string[]> = {
  soft_feminine_editorial: ["self-love", "self love", "worth", "gentle", "soft", "beautiful", "woman", "girl", "deserve", "bloom"],
  rainy_window: ["miss", "missing", "lonely", "alone", "rain", "night", "tears", "cry", "gone", "silence"],
  vintage_paper: ["memory", "memories", "letter", "unsaid", "never said", "remember", "old", "poem", "words"],
  dreamy_sky: ["hope", "dream", "fly", "free", "sky", "begin", "tomorrow", "light", "rise"],
  dark_romantic: ["betray", "betrayal", "lie", "lied", "cheat", "trust", "toxic", "pain", "hurt", "broke", "broken"],
  cozy_journal: ["overthink", "journal", "reflect", "today", "growth", "grateful", "slow", "morning", "routine"],
  minimal_typography: ["boundary", "boundaries", "respect", "enough", "standard", "strong", "affirmation", "no longer", "choose"],
  peaceful_ocean: ["let go", "letting go", "peace", "calm", "accept", "acceptance", "ocean", "sea", "breathe"],
  golden_hour_lifestyle: ["happy", "happiness", "gratitude", "home", "warm", "joy", "smile", "good things", "new beginning"],
  misty_nature: ["heal", "healing", "grow", "resilience", "solitude", "quiet", "roots", "forest", "patience"],
};

/** Picks a style from topic/quote keywords; `avoid` lets a batch rotate styles instead of repeating one. */
export function suggestStyle(text: string, avoid: ImageStyle[] = []): ImageStyle {
  const t = text.toLowerCase();
  const scored = IMAGE_STYLE_KEYS.map((k) => ({ k, score: STYLE_KEYWORDS[k].filter((w) => t.includes(w)).length - avoid.filter((a) => a === k).length * 0.75 }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.score > 0 ? scored[0]!.k : IMAGE_STYLE_KEYS.find((k) => !avoid.includes(k)) ?? "soft_feminine_editorial";
}

export const GLOBAL_NEGATIVE =
  "No text, letters, words, numbers, handwriting, calligraphy, typography, logos, watermarks, signatures, labels, printed book text, visible signs or poster graphics. No frames, no borders, no collage.";

const pick = <T>(arr: readonly T[], i: number) => arr[((i % arr.length) + arr.length) % arr.length]!;

/**
 * Builds a style-aware background prompt in a fixed order:
 * 1 style description → 2 compatible scene hint → 3 composition / text-safe area → 4 lighting & palette →
 * 5 quality → 6 negatives. The scene hint is only a creative suggestion and never overrides the style.
 * `variant` picks lighting/framing/material variations so pins in one batch don't look identical.
 */
export function buildBackgroundPrompt(styleId: ImageStyle | string, sceneHint?: string | null, variant = 0): string {
  const s = styleConfig(styleId);
  const regionText: Record<TextRegion, string> = {
    upper: "the upper third",
    upper_middle: "the upper-middle area",
    middle: "the centre",
    lower: "the lower third",
  };
  const v = s.variations;
  const hint = sceneHint?.trim().replace(/\.$/, "");
  const parts = [
    `${s.prompt}.`,
    hint
      ? `Optional creative detail — use it only if it fits the "${s.label}" style, otherwise ignore it: ${hint}.`
      : "",
    `Composition: ${s.composition}. Variation: ${pick(v.framing, variant)}, ${pick(v.material, variant + 1)}. ` +
      `Vertical 2:3 portrait. Keep a genuinely low-detail, smooth area in ${regionText[s.textRegion]} for a typographic quote to be added later; no objects or strong texture there.`,
    `Lighting: ${s.lighting}, ${pick(v.light, variant + 2)}. Palette: ${s.palettePrompt}; restrained and harmonious.`,
    `Quality: natural believable materials, realistic shadows, controlled highlights, subtle depth, polished and premium, no AI artifacts, no plastic textures, not oversaturated.`,
    `Avoid: ${s.avoid}. ${GLOBAL_NEGATIVE}`,
  ];
  return parts.filter(Boolean).join("\n");
}

export const TYPOGRAPHY_PRESETS = {
  elegant_serif: { label: "Elegant italic (Cormorant)", file: "CormorantGaramond_500Medium_Italic.ttf", family: "Cormorant Garamond Medium Italic", lineSpacing: 1.2, sizeScale: 1.0 },
  classic_serif: { label: "Classic serif (Cormorant)", file: "CormorantGaramond_500Medium.ttf", family: "Cormorant Garamond Medium", lineSpacing: 1.2, sizeScale: 0.97 },
  serif_italic: { label: "Garamond italic", file: "EBGaramond_400Regular_Italic.ttf", family: "EB Garamond Italic", lineSpacing: 1.24, sizeScale: 0.9 },
  book_serif: { label: "Playfair", file: "PlayfairDisplay_500Medium.ttf", family: "Playfair Display Medium", lineSpacing: 1.22, sizeScale: 0.82 },
  modern_sans: { label: "Modern sans", file: "Montserrat_500Medium.ttf", family: "Montserrat Medium", lineSpacing: 1.3, sizeScale: 0.72, letterSpacing: 0.02 },
  light_sans: { label: "Light sans", file: "Montserrat_300Light.ttf", family: "Montserrat Light", lineSpacing: 1.3, sizeScale: 0.74, letterSpacing: 0.03 },
  display_thin: { label: "Thin display (Italiana)", file: "Italiana_400Regular.ttf", family: "Italiana", lineSpacing: 1.22, sizeScale: 0.85, letterSpacing: 0.02 },
  handwritten: { label: "Handwritten", file: "DancingScript_600SemiBold.ttf", family: "Dancing Script SemiBold", lineSpacing: 1.12, sizeScale: 0.95 },
} as const satisfies Record<string, { label: string; file: string; family: string; lineSpacing: number; sizeScale: number; letterSpacing?: number }>;

export type TypographyPreset = keyof typeof TYPOGRAPHY_PRESETS;
export const TYPOGRAPHY_KEYS = Object.keys(TYPOGRAPHY_PRESETS) as TypographyPreset[];
export function isTypographyPreset(s: unknown): s is TypographyPreset {
  return typeof s === "string" && s in TYPOGRAPHY_PRESETS;
}
