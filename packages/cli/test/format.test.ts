import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@l10n-review/core";
import { describe, expect, it } from "vitest";
import { input, resolveBase } from "../src/action.ts";
import { formatGithub, formatSummary, formatText } from "../src/format.ts";

const finding: Finding = {
  ruleId: "locale-placeholders",
  path: "locales/zh-TW,a:b.json",
  line: 6,
  column: 5,
  severity: "error",
  message: "100% wrong\nsecond line | with a pipe",
  text: "t",
};

describe("formatGithub", () => {
  it("writes workflow commands, escaping data and properties as GitHub requires", () => {
    expect(formatGithub([finding])).toBe(
      "::error file=locales/zh-TW%2Ca%3Ab.json,line=6,col=5,title=l10n-review%3A locale-placeholders::100%25 wrong%0Asecond line | with a pipe",
    );
    expect(formatGithub([{ ...finding, severity: "warning" }])).toMatch(/^::warning /);
    expect(formatGithub([])).toBe("");
  });
});

describe("formatText and formatSummary", () => {
  it("summarize with correct plurals", () => {
    expect(formatText([], 1)).toBe("No localization issues in 1 file.");
    expect(formatText([finding], 2).split("\n").at(-1)).toBe(
      "1 issue (1 error) in 2 files checked.",
    );
  });

  it("escape table cells in the job summary", () => {
    expect(formatSummary([finding], 1)).toContain("second line \\| with a pipe");
    expect(formatSummary([finding], 1)).toContain("1 issue in 1 file.");
  });

  it("say in the job summary when GitHub will drop annotations", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...finding, line: i + 1 }));
    expect(formatSummary(many(10), 1)).not.toContain("at most 10 annotations");
    expect(formatSummary(many(11), 1)).toContain("All 11 are listed here.");
  });
});

describe("action inputs", () => {
  it("reads inputs the way GitHub passes them", () => {
    expect(input("fail-on", { "INPUT_FAIL-ON": " warning " })).toBe("warning");
    expect(input("base", {})).toBe("");
  });

  it("resolves the base: explicit input, then the PR's base commit, then the base branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l10n-review-event-"));
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: "abc123" } } }));

    expect(await resolveBase({ INPUT_BASE: "develop", GITHUB_EVENT_PATH: event })).toBe("develop");
    expect(await resolveBase({ GITHUB_EVENT_PATH: event })).toBe("abc123");
    expect(await resolveBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
    await expect(resolveBase({})).rejects.toThrow('Set the "base" input');
  });
});
