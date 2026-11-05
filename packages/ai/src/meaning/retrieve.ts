import type { LoadedLocale } from "@l10n-review/core";

// Style examples for the meaning/tone check: other translations from the same product, so the
// model can see its register (您 or 你, polite or casual) and its vocabulary.
//
// Ranking: character trigram similarity of the *source* strings (the same idea as Postgres'
// pg_trgm), plus a bonus for keys in the same namespace (cart.* next to cart.checkout).
// Everything is already in memory: the review loaded these locale files. A database index
// only becomes worth it for memory shared across repositories or very large catalogs.

export interface Example {
  key: string;
  source: string;
  translation: string;
}

export function trigrams(text: string): Set<string> {
  const chars = [..." ", ...text.toLowerCase().replace(/\s+/g, " "), " "];
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(""));
  return grams;
}

/** Jaccard similarity of trigram sets, 0..1 (pg_trgm's similarity()). */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

const namespace = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf(".")));

export function findExamples(
  target: LoadedLocale,
  source: LoadedLocale,
  key: string,
  sourceText: string,
  limit = 4,
): Example[] {
  const scored: { example: Example; score: number }[] = [];
  for (const entry of target.entries.values()) {
    if (entry.key === key) continue;
    const original = source.entries.get(entry.key);
    if (!original) continue;
    const sameNamespace = namespace(entry.key) !== "" && namespace(entry.key) === namespace(key);
    const score = similarity(sourceText, original.value) + (sameNamespace ? 0.3 : 0);
    if (score > 0) {
      scored.push({
        example: { key: entry.key, source: original.value, translation: entry.value },
        score,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.example.key.localeCompare(b.example.key))
    .slice(0, limit)
    .map((s) => s.example);
}
