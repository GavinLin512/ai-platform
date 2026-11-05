import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  createLocaleKeysRule,
  createLocalePlaceholdersRule,
  memoryReader,
  type Rule,
  runRules,
} from "../../src/core/index.ts";

/** Pretty-prints a JSON object one key per line, so tests can point at line numbers. */
const json = (object: Record<string, unknown>) => JSON.stringify(object, null, 2);

/**
 * Runs `rule` on the changed files, with `repo` as the rest of the repository at head.
 * Each changed file lists the keys the PR added; those keys' lines become the added lines.
 */
async function review(
  rule: Rule,
  repo: Record<string, string>,
  changed: Record<string, string[] | "all">,
) {
  const files: ChangedFile[] = Object.entries(changed).map(([path, keys]) => {
    const content = repo[path] as string;
    if (keys === "all") return { path, content };
    const lines = content.split("\n");
    const addedLines = new Set(
      keys.map((key) => lines.findIndex((line) => line.includes(`"${key}":`)) + 1),
    );
    return { path, content, addedLines };
  });
  const findings = await runRules(files, { rules: [rule], reader: memoryReader(repo) });
  return findings.map(({ path, line, message }) => ({ path, line, message }));
}

describe("locale-keys", () => {
  const rule = createLocaleKeysRule();

  it("reports a key added to the source that other locales lack, on the source line", async () => {
    const repo = {
      "locales/en.json": json({ "cart.title": "Cart", "cart.checkout": "Checkout" }),
      "locales/ja.json": json({ "cart.title": "カート" }),
      "locales/zh-TW.json": json({ "cart.title": "購物車" }),
      "locales/ko.json": json({ "cart.title": "장바구니", "cart.checkout": "결제" }),
    };
    expect(await review(rule, repo, { "locales/en.json": ["cart.checkout"] })).toEqual([
      {
        path: "locales/en.json",
        line: 3,
        message:
          'Key "cart.checkout" is missing from ja and zh-TW. Users of those languages will see the fallback language or the raw key instead.',
      },
    ]);
  });

  it("does not ask CJK locales for plural forms their language does not have", async () => {
    const repo = {
      "locales/en.json": json({ item_one: "{{count}} item", item_other: "{{count}} items" }),
      "locales/ja.json": json({ item_other: "{{count}} 点" }),
      "locales/zh-TW.json": json({ item_other: "{{count}} 件" }),
      "locales/ru.json": json({ item_other: "…", item_few: "…", item_many: "…" }),
    };
    const findings = await review(rule, repo, { "locales/en.json": ["item_one", "item_other"] });
    // Only Russian, which really has a "one" form, is reported.
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('Key "item_one" is missing from ru.'),
    ]);
  });

  it("reports a key added to a translation that the source lacks, with a suggestion", async () => {
    const repo = {
      "locales/en.json": json({ "cart.checkout": "Checkout" }),
      "locales/ja.json": json({ "cart.chekout": "購入手続き" }),
    };
    expect(await review(rule, repo, { "locales/ja.json": ["cart.chekout"] })).toEqual([
      {
        path: "locales/ja.json",
        line: 2,
        message:
          'Key "cart.chekout" does not exist in the source locale (locales/en.json), so it is never used. Did you mean "cart.checkout"?',
      },
    ]);
  });

  it("accepts plural forms the translation's language needs even if the source lacks them", async () => {
    const repo = {
      "locales/en.json": json({ item_one: "…", item_other: "…" }),
      "locales/ru.json": json({ item_one: "…", item_few: "…", item_many: "…", item_other: "…" }),
    };
    expect(await review(rule, repo, { "locales/ru.json": "all" })).toEqual([]);
  });

  it("works with one directory per locale", async () => {
    const repo = {
      "public/locales/en/common.json": json({ greeting: "Hi", bye: "Bye" }),
      "public/locales/zh-TW/common.json": json({ greeting: "嗨" }),
    };
    const findings = await review(rule, repo, { "public/locales/en/common.json": ["bye"] });
    expect(findings).toMatchObject([{ path: "public/locales/en/common.json", line: 3 }]);
  });

  it("ignores old gaps on lines the change did not touch", async () => {
    const repo = {
      "locales/en.json": json({ old: "Old", fresh: "Fresh" }),
      "locales/ja.json": json({ fresh: "新しい" }),
    };
    expect(await review(rule, repo, { "locales/en.json": ["fresh"] })).toEqual([]);
  });

  it("stays silent without a source locale file or with invalid JSON", async () => {
    expect(
      await review(rule, { "locales/ja.json": json({ a: "あ" }) }, { "locales/ja.json": "all" }),
    ).toEqual([]);
    expect(
      await review(
        rule,
        { "locales/en.json": "{ broken", "locales/ja.json": json({ a: "あ" }) },
        { "locales/en.json": "all" },
      ),
    ).toEqual([]);
  });

  it("supports a different source locale", async () => {
    const zhFirst = createLocaleKeysRule({ sourceLocale: "zh-TW" });
    const repo = {
      "locales/zh-TW.json": json({ title: "購物車", checkout: "結帳" }),
      "locales/en.json": json({ title: "Cart" }),
    };
    const findings = await review(zhFirst, repo, { "locales/zh-TW.json": ["checkout"] });
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining('Key "checkout" is missing from en.'),
    ]);
  });
});

describe("locale-placeholders", () => {
  const rule = createLocalePlaceholdersRule();

  it("reports a translation whose placeholders differ from the source", async () => {
    const repo = {
      "locales/en.json": json({ shipping: "Free shipping on orders over {amount}" }),
      "locales/zh-TW.json": json({ shipping: "滿 {price} 免運" }),
    };
    expect(await review(rule, repo, { "locales/zh-TW.json": ["shipping"] })).toEqual([
      {
        path: "locales/zh-TW.json",
        line: 2,
        message:
          'Placeholders in "shipping" don\'t match en: missing {amount}, unknown {price}. Source: "Free shipping on orders over {amount}"',
      },
    ]);
  });

  it("reports translations left behind when the source changes, once per issue", async () => {
    const repo = {
      "locales/en.json": json({ shipping: "Free shipping over {price}" }),
      "locales/ja.json": json({ shipping: "{amount}以上で送料無料" }),
      "locales/zh-TW.json": json({ shipping: "滿 {amount} 免運" }),
    };
    // The PR renamed {amount} → {price} in en and also touched zh-TW, but forgot ja.
    const findings = await review(rule, repo, {
      "locales/en.json": ["shipping"],
      "locales/zh-TW.json": ["shipping"],
    });
    expect(findings).toEqual([
      {
        path: "locales/en.json",
        line: 2,
        message:
          'The placeholders of "shipping" no longer match its translations: ja (missing {price}, unknown {amount}). Update the translations, or they will render the wrong values.',
      },
      expect.objectContaining({ path: "locales/zh-TW.json", line: 2 }),
    ]);
  });

  it("accepts ICU plurals with fewer branches, as CJK languages need", async () => {
    const repo = {
      "locales/en.json": json({ items: "{count, plural, one {# item} other {# items}}" }),
      "locales/ja.json": json({ items: "{count, plural, other {#点}}" }),
    };
    expect(await review(rule, repo, { "locales/ja.json": "all" })).toEqual([]);
  });

  it("reports broken ICU syntax", async () => {
    const repo = {
      "locales/en.json": json({ items: "{count} items" }),
      "locales/zh-TW.json": json({ items: "共 {count 件" }),
    };
    const [finding] = await review(rule, repo, { "locales/zh-TW.json": "all" });
    expect(finding?.message).toContain("not a valid ICU message (MALFORMED_ARGUMENT)");
  });

  it("handles i18next placeholders and catches single braces in an i18next project", async () => {
    const repo = {
      "locales/en.json": json({ items: "{{count}} items", hi: "Hi {{name}}" }),
      "locales/ja.json": json({ items: "{{cnt}}点", hi: "{name}さん" }),
    };
    const findings = await review(rule, repo, { "locales/ja.json": "all" });
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining("missing {{count}}, unknown {{cnt}}"),
      expect.stringContaining("uses {name} instead of {{name}}"),
    ]);
  });
});
