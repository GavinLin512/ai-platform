import { type ChangedFile, memoryReader, runRules } from "@l10n-review/core";
import { describe, expect, it } from "vitest";
import { createZhTwTerminologyRule, fakeLlmClient, UsageMeter } from "../src/index.ts";

const zhTW = JSON.stringify(
  {
    "app.update": "軟件更新",
    "cart.title": "購物車",
    "cart.checkout": "立即結算",
    thanks: "感謝您的支持",
  },
  null,
  2,
);
// Lines 2–5 hold the four keys above.
const file = (addedLines?: number[]): ChangedFile => ({
  path: "locales/zh-TW.json",
  content: zhTW,
  addedLines: addedLines && new Set(addedLines),
});

function review(llm: ReturnType<typeof fakeLlmClient>, f = file(), options = {}) {
  const rule = createZhTwTerminologyRule(llm, options);
  return runRules([f], { rules: [rule], reader: memoryReader({ [f.path]: f.content }) });
}

/** A fake model: flags 軟件 and 結算 and 支持; the verifier rejects 支持. */
function scriptedModel() {
  return fakeLlmClient((request) => {
    const input = JSON.parse(request.prompt) as { id: string; text: string; term?: string }[];
    if (request.purpose === "terminology.judge") {
      return {
        items: input.map(({ id, text }) => ({
          id,
          problems: [
            text.includes("軟件") && {
              term: "軟件",
              suggestion: "軟體",
              reason: "台灣慣用「軟體」。",
            },
            text.includes("結算") && {
              term: "結算",
              suggestion: "結帳",
              reason: "台灣電商說「結帳」。",
            },
            text.includes("支持") && { term: "支持", suggestion: "支援", reason: "（誤判）" },
          ].filter(Boolean),
        })),
      };
    }
    return { items: input.map(({ id, term }) => ({ id, term, confirmed: term !== "支持" })) };
  });
}

describe("zh-tw-terminology", () => {
  it("applies to Taiwan Chinese locale files only", () => {
    const rule = createZhTwTerminologyRule(fakeLlmClient(() => ({})));
    expect(rule.appliesTo("locales/zh-TW.json")).toBe(true);
    expect(rule.appliesTo("locales/zh_Hant.json")).toBe(true);
    expect(rule.appliesTo("locales/zh-CN.json")).toBe(false);
    expect(rule.appliesTo("locales/ja.json")).toBe(false);
  });

  it("sends only dictionary candidates, and comments only on verified problems", async () => {
    const llm = scriptedModel();
    const findings = await review(llm);

    const judged = JSON.parse(llm.calls[0]?.prompt ?? "[]") as { text: string }[];
    expect(judged.map((item) => item.text)).toEqual(["軟件更新", "立即結算", "感謝您的支持"]); // not 購物車
    expect(findings.map((f) => [f.line, f.message])).toEqual([
      [2, "「軟件」在台灣通常說「軟體」。台灣慣用「軟體」。"],
      [4, "「結算」在台灣通常說「結帳」。台灣電商說「結帳」。"],
    ]); // 支持 was proposed but not confirmed
  });

  it("can skip verification", async () => {
    const findings = await review(scriptedModel(), file(), { verify: false });
    expect(findings.map((f) => f.text)).toEqual([
      "app.update:軟件",
      "cart.checkout:結算",
      "thanks:支持",
    ]);
  });

  it("only looks at lines the change added, and makes no call when nothing qualifies", async () => {
    const llm = scriptedModel();
    expect((await review(llm, file([4]))).map((f) => f.line)).toEqual([4]);

    const idle = scriptedModel();
    expect(await review(idle, file([3]))).toEqual([]); // 購物車: no candidate
    expect(idle.calls).toEqual([]);
  });

  it("ignores problems whose term is not in the text", async () => {
    const llm = fakeLlmClient((request) =>
      request.purpose === "terminology.judge"
        ? { items: [{ id: "0", problems: [{ term: "視頻", suggestion: "影片", reason: "…" }] }] }
        : { items: [] },
    );
    expect(await review(llm, file([2]))).toEqual([]);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["terminology.judge"]);
  });

  it("records a failed call and keeps the review going", async () => {
    const meter = new UsageMeter();
    const broken = fakeLlmClient(() => {
      throw new Error("529 overloaded");
    });
    await expect(review(broken, file(), { meter })).resolves.toEqual([]);
    expect(meter.failures).toEqual([
      { purpose: "terminology.judge", error: "Error: 529 overloaded" },
    ]);
  });
});
