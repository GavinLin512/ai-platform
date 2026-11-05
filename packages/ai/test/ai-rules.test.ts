import { describe, expect, it } from "vitest";
import { createAiRules, fakeLlmClient } from "../src/index.ts";

describe("createAiRules", () => {
  const llm = fakeLlmClient(() => ({ items: [] }));
  it("adds both checks unless .l10nrc.yml turns them off", () => {
    expect(createAiRules({}, llm).map((r) => r.id)).toEqual([
      "zh-tw-terminology",
      "translation-meaning",
    ]);
    expect(
      createAiRules({ rules: { "translation-meaning": false } }, llm).map((r) => r.id),
    ).toEqual(["zh-tw-terminology"]);
  });
});
