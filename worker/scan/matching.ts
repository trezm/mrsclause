// Cheap, local fuzzy matching between gift-list names and product
// descriptions from order emails. Used as a fallback (and sanity check) for
// the model's own suggestions.

const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "of", "with", "in", "on", "to", "by", "from", "or",
  "new", "pack", "pk", "set", "size", "color", "colour", "edition", "item", "qty",
  "mens", "womens", "kids", "boys", "girls", "adult", "adults", "unisex", "gift",
  "black", "white", "blue", "red", "green", "pink", "gray", "grey",
  "small", "medium", "large", "xl", "xs", "one",
]);

export function tokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/['\u2019]s\b/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return [...new Set(words)];
}

/**
 * How much of the gift-list name is covered by the product description,
 * from 0 to 1. List names are short ("Lego Falcon") and descriptions long, so
 * coverage of the shorter side is what matters.
 */
export function matchScore(listName: string, description: string): number {
  const want = tokens(listName);
  if (want.length === 0) return 0;
  const have = new Set(tokens(description));
  const hits = want.filter((t) => have.has(t)).length;
  const coverage = hits / want.length;
  // A single generic word ("socks") is weaker evidence than several.
  return want.length === 1 ? coverage * 0.75 : coverage;
}

/**
 * Similarity between two descriptions of possibly the same product, from 0
 * to 1. Emails often shorten names ("LEGO Star Wars Millennium Falcon 75192
 * Building..."), so this measures how much of the shorter one is contained in
 * the longer. Different model numbers mean different products.
 */
export function sameProductScore(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const modelNumbers = (t: string[]) => t.filter((w) => /\d/.test(w) && w.length >= 4);
  const ma = modelNumbers(ta);
  const mb = new Set(modelNumbers(tb));
  if (ma.length && mb.size && !ma.some((m) => mb.has(m))) return 0;
  const [shorter, longer] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return shorter.filter((t) => longer.has(t)).length / shorter.length;
}

/** Score at which two order-line descriptions count as the same product. */
export const SAME_PRODUCT_THRESHOLD = 0.85;

export function bestMatch<T extends { name: string }>(
  description: string,
  candidates: T[],
  threshold = 0.6,
): { candidate: T; score: number } | null {
  let best: { candidate: T; score: number } | null = null;
  for (const candidate of candidates) {
    const score = matchScore(candidate.name, description);
    if (score >= threshold && (!best || score > best.score)) best = { candidate, score };
  }
  return best;
}

/** Matches a shipping-label name like "Margaret Smith" to a recipient like "Grandma Margaret". */
export function matchRecipientName<T extends { name: string }>(shipTo: string | null, recipients: T[]): T | null {
  if (!shipTo) return null;
  const shipTokens = new Set(tokens(shipTo));
  for (const r of recipients) {
    const nameTokens = tokens(r.name).filter((t) => t.length > 2);
    if (nameTokens.some((t) => shipTokens.has(t))) return r;
  }
  return null;
}
