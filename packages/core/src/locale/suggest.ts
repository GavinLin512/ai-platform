/** Number of single-character edits (insert, delete, replace) to turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The candidate closest to `key`, if it is close enough to plausibly be a typo. */
export function closestMatch(key: string, candidates: Iterable<string>): string | undefined {
  const maxDistance = Math.min(2, Math.floor(key.length / 4));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
}
