import { memoryReader, runRules } from "@l10n-review/core";
import { describe, expect, it } from "vitest";
import {
  createTranslationMeaningRule,
  fakeLlmClient,
  findExamples,
  similarity,
} from "../src/index.ts";

const en = JSON.stringify(
  {
    "cart.add": "Add to cart",
    "cart.remove": "Remove from cart",
    "cart.empty": "Your cart is empty",
    "order.cancel": "Cancel order",
  },
  null,
  2,
);
const zhTW = JSON.stringify(
  {
    "cart.add": "加入購物車",
    "cart.remove": "從購物車移除",
    "cart.empty": "您的購物車是空的",
    "order.cancel": "確認訂單",
  },
  null,
  2,
);
const repo = { "locales/en.json": en, "locales/zh-TW.json": zhTW };

describe("similarity", () => {
  it("scores like pg_trgm: identical 1, unrelated 0", () => {
    expect(similarity("Add to cart", "Add to cart")).toBe(1);
    expect(similarity("Add to cart", "Remove from cart")).toBeGreaterThan(
      similarity("Add to cart", "xyz"),
    );
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("translation-meaning", () => {
  it("sends source, translation and style examples, and reports confirmed issues", async () => {
    const llm = fakeLlmClient((request) => {
      const items = JSON.parse(request.prompt) as { id: string; translation: string }[];
      if (request.purpose === "meaning.judge") {
        return {
          items: items.map(({ id, translation }) => ({
            id,
            issues:
              translation === "確認訂單"
                ? [
                    {
                      kind: "meaning",
                      explanation: "Says 'confirm' instead of 'cancel'.",
                      suggestion: "取消訂單",
                    },
                  ]
                : [{ kind: "style-nit", explanation: "ignored kind", suggestion: "x" }],
          })),
        };
      }
      return { items: items.map(({ id }) => ({ id, kind: "meaning", confirmed: true })) };
    });
    const rule = createTranslationMeaningRule(llm);
    const findings = await runRules(
      [{ path: "locales/zh-TW.json", content: zhTW, addedLines: new Set([4, 5]) }],
      { rules: [rule], reader: memoryReader(repo) },
    );

    const sent = JSON.parse(llm.calls[0]?.prompt ?? "[]") as {
      key: string;
      styleExamples: { key: string }[];
    }[];
    expect(sent.map((s) => s.key)).toEqual(["cart.empty", "order.cancel"]);
    expect(sent[0]?.styleExamples[0]?.key).toMatch(/^cart\./); // same namespace ranks first
    expect(findings.map((f) => [f.line, f.text])).toEqual([[5, "order.cancel:meaning"]]);
    expect(findings[0]?.message).toContain('Suggested: "取消訂單" (source: "Cancel order")');
  });

  it("never reviews the source locale itself", async () => {
    const llm = fakeLlmClient(() => ({ items: [] }));
    const rule = createTranslationMeaningRule(llm);
    expect(rule.appliesTo("locales/en.json")).toBe(false);
    expect(
      createTranslationMeaningRule(llm, { sourceLocale: "zh-TW" }).appliesTo("locales/zh-TW.json"),
    ).toBe(false);
  });
});

describe("findExamples", () => {
  it("ranks the same namespace and similar sources first, excluding the entry itself", async () => {
    const { loadLocaleSet } = await import("@l10n-review/core");
    const set = await loadLocaleSet(
      { path: "locales/zh-TW.json", content: zhTW },
      memoryReader(repo),
      {},
    );
    if (!set?.source) throw new Error("no source locale");
    const examples = findExamples(set.self, set.source, "cart.add", "Add to cart", 2);
    expect(examples.map((e) => e.key)).toEqual(["cart.remove", "cart.empty"]);
  });
});
