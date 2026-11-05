import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confusion, metrics, outcome, termsFound } from "../eval/score.ts";
import { detectCandidate } from "../src/index.ts";

describe("eval scoring", () => {
  it("computes precision, recall and F1", () => {
    const m = metrics(confusion(["TP", "TP", "TP", "FP", "FN", "TN"]));
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.75);
    expect(m.f1).toBeCloseTo(0.75);
  });

  it("treats 'flagged nothing' as perfect precision, not a division by zero", () => {
    expect(metrics(confusion(["TN", "FN"])).precision).toBe(1);
  });

  it("matches overlapping terms", () => {
    expect(termsFound(["網絡", "設置"], ["網絡連接"])).toBe(1);
    expect(outcome(true, false)).toBe("FN");
  });
});

describe("dictionary baseline on the eval set", () => {
  const cases = readFileSync(new URL("../eval/cases/terminology.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; text: string; expected: string[] });

  it("still finds every mainland term (recall must not regress)", () => {
    const missed = cases.filter((c) => c.expected.length > 0 && !detectCandidate(c.text));
    expect(missed.map((c) => c.id)).toEqual([]);
  });

  it("over-flags exactly the context-dependent words the LLM has to resolve", () => {
    const falsePositives = cases.filter((c) => c.expected.length === 0 && detectCandidate(c.text));
    // 支持 (endorse), 文件 (document), 項目 (item), 查看, 優化, 程序 (procedure)
    expect(falsePositives.map((c) => c.id)).toEqual(["t26", "t31", "t32", "t33", "t34", "t36"]);
  });
});
