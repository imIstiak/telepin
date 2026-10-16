const STOPWORDS = new Set(
  "a an the and or but if of to in on at for with is are was were be been am i me my you your we our it its this that those these not no so as by from just".split(
    " ",
  ),
);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
}

function shingles(s: string, n = 2): Set<string> {
  const t = normalizeText(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Lexical similarity in [0,1] combining content-word overlap and word-bigram overlap. */
export function lexicalSimilarity(a: string, b: string): number {
  if (normalizeText(a) === normalizeText(b)) return 1;
  const words = jaccard(new Set(tokens(a)), new Set(tokens(b)));
  const bigrams = jaccard(shingles(a), shingles(b));
  return Math.max(words * 0.8, bigrams);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Truncate at a word boundary without exceeding max characters. */
export function clampText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:-]+$/, "") + "…";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for Pango/SVG markup (also escapes quotes). */
export function escapeMarkup(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Remove surrounding quote marks and any "— Author" attribution the model may add. */
export function cleanQuote(s: string): string {
  return s
    .trim()
    .replace(/\s*[—–-]\s*[A-Z][\w .'-]{1,40}$/u, "")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
