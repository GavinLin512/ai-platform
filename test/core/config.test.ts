import { describe, expect, it } from "vitest";
import {
  analyzeChanges,
  createRules,
  loadConfig,
  loadReviewSetup,
  memoryReader,
  parseConfig,
} from "../../src/core/index.ts";

describe("parseConfig", () => {
  it("reads a valid configuration", () => {
    const text = `sourceLocale: zh-TW
localeDirs: [locales, lang]
ignore: ["legacy/**"]
rules:
  locale-keys: false
  no-hardcoded-string:
    attributes: [title, tooltip]
`;
    expect(parseConfig(".l10nrc.yml", text)).toEqual({
      path: ".l10nrc.yml",
      problems: [],
      config: {
        sourceLocale: "zh-TW",
        localeDirs: ["locales", "lang"],
        ignore: ["legacy/**"],
        rules: {
          "locale-keys": false,
          "no-hardcoded-string": { attributes: ["title", "tooltip"] },
        },
      },
    });
  });

  it("accepts an empty file", () => {
    expect(parseConfig(".l10nrc.yml", "")).toMatchObject({ config: {}, problems: [] });
  });

  it("points at the line of an unknown setting, so typos do not go unnoticed", () => {
    const text = "sourceLocale: en\nrules:\n  no-hardcoded-strng: false\n";
    expect(parseConfig(".l10nrc.yml", text).problems).toEqual([
      { line: 3, column: 3, message: 'Unknown setting "rules.no-hardcoded-strng".' },
    ]);
  });

  it("points at the line of a wrongly typed value", () => {
    const text = "sourceLocale: en\nignore: legacy/**\n";
    const [problem] = parseConfig(".l10nrc.yml", text).problems;
    expect(problem).toMatchObject({ line: 2, column: 9 });
    expect(problem?.message).toContain('"ignore"');
  });

  it("reports invalid YAML and falls back to the defaults", () => {
    const loaded = parseConfig(".l10nrc.yml", "rules:\n  locale-keys: [oops\n");
    expect(loaded.config).toEqual({});
    expect(loaded.problems[0]?.message).toMatch(/^Invalid YAML/);
  });
});

describe("loadConfig", () => {
  it("finds .l10nrc.yml or .l10nrc.yaml, or returns the defaults", async () => {
    expect(await loadConfig(memoryReader({}))).toEqual({ config: {}, problems: [] });
    const yaml = await loadConfig(memoryReader({ ".l10nrc.yaml": "sourceLocale: ja" }));
    expect(yaml).toMatchObject({ path: ".l10nrc.yaml", config: { sourceLocale: "ja" } });
  });
});

describe("createRules", () => {
  it("includes every rule by default and leaves out disabled ones", () => {
    expect(createRules().map((r) => r.id)).toEqual([
      "no-hardcoded-string",
      "locale-keys",
      "locale-placeholders",
      "intl-format",
    ]);
    expect(
      createRules({ rules: { "intl-format": false, "locale-keys": false } }).map((r) => r.id),
    ).toEqual(["no-hardcoded-string", "locale-placeholders"]);
  });
});

describe("analyzeChanges with a configuration", () => {
  const button = "export const A = () => <button>Checkout</button>;";

  it("applies rule options and ignore globs from .l10nrc.yml", async () => {
    const repo = {
      ".l10nrc.yml":
        'ignore: ["legacy/**"]\nrules:\n  no-hardcoded-string:\n    ignoreElements: [button]\n',
      "src/A.tsx": button,
      "src/B.tsx": "export const B = () => <p>Hello</p>;",
      "legacy/C.tsx": "export const C = () => <p>Old</p>;",
    };
    const reader = memoryReader(repo);
    const setup = await loadReviewSetup(reader);
    const files = ["src/A.tsx", "src/B.tsx", "legacy/C.tsx"].map((path) => ({
      path,
      content: repo[path as keyof typeof repo],
    }));

    const findings = await analyzeChanges(files, reader, setup);
    expect(findings.map((f) => `${f.path}:${f.text}`)).toEqual(["src/B.tsx:Hello"]);
  });

  it("uses sourceLocale from the configuration", async () => {
    const repo = {
      ".l10nrc.yml": "sourceLocale: zh-TW\n",
      "locales/zh-TW.json": '{\n  "title": "購物車",\n  "checkout": "結帳"\n}',
      "locales/en.json": '{\n  "title": "Cart"\n}',
    };
    const reader = memoryReader(repo);
    const setup = await loadReviewSetup(reader);
    const findings = await analyzeChanges(
      [{ path: "locales/zh-TW.json", content: repo["locales/zh-TW.json"] }],
      reader,
      setup,
    );
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('Key "checkout" is missing from en.'),
    ]);
  });

  it("reports a broken configuration on the changed config line, and keeps reviewing", async () => {
    const repo = {
      ".l10nrc.yml": "sourceLocale: en\nrules:\n  intl-formats: false\n",
      "src/A.tsx": button,
    };
    const reader = memoryReader(repo);
    const setup = await loadReviewSetup(reader);
    const findings = await analyzeChanges(
      [
        { path: ".l10nrc.yml", content: repo[".l10nrc.yml"], addedLines: new Set([3]) },
        { path: "src/A.tsx", content: button },
      ],
      reader,
      setup,
    );
    expect(findings.map((f) => `${f.ruleId}@${f.path}:${f.line}`)).toEqual([
      "config@.l10nrc.yml:3",
      "no-hardcoded-string@src/A.tsx:1",
    ]);
    expect(findings[0]?.message).toBe(
      'Unknown setting "rules.intl-formats". The default configuration is used until this is fixed.',
    );
  });
});
