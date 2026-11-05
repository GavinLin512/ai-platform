// Scoring for the eval sets. Kept apart from the runner so it can be unit-tested: a bug in
// the scorer silently makes every number wrong.

export interface Confusion {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export interface Metrics extends Confusion {
  /** Of the strings we flagged, how many really had a problem. The number that matters most. */
  precision: number;
  /** Of the strings with a problem, how many we flagged. */
  recall: number;
  f1: number;
}

export function metrics(c: Confusion): Metrics {
  const flagged = c.truePositives + c.falsePositives;
  const actual = c.truePositives + c.falseNegatives;
  const precision = flagged === 0 ? 1 : c.truePositives / flagged;
  const recall = actual === 0 ? 1 : c.truePositives / actual;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...c, precision, recall, f1 };
}

export type Outcome = "TP" | "FP" | "FN" | "TN";

export function outcome(expectedPositive: boolean, predictedPositive: boolean): Outcome {
  if (expectedPositive) return predictedPositive ? "TP" : "FN";
  return predictedPositive ? "FP" : "TN";
}

export function confusion(outcomes: Outcome[]): Confusion {
  const count = (o: Outcome) => outcomes.filter((x) => x === o).length;
  return {
    truePositives: count("TP"),
    falsePositives: count("FP"),
    falseNegatives: count("FN"),
    trueNegatives: count("TN"),
  };
}

/** An expected term counts as found when a predicted term overlaps it (網絡 vs 網絡連接). */
export function termsFound(expected: string[], predicted: string[]): number {
  return expected.filter((e) => predicted.some((p) => p.includes(e) || e.includes(p))).length;
}
