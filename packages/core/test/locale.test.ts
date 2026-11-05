import { describe, expect, it } from "vitest";
import { memoryReader } from "../src/index.ts";
import { parseLocaleJson } from "../src/locale/json.ts";
import {
  findSiblingLocales,
  isKnownLocale,
  parseLocalePath,
  sameLocale,
} from "../src/locale/paths.ts";
import { extractPlaceholders } from "../src/locale/placeholders.ts";
import { isRequiredIn, splitPluralKey } from "../src/locale/plural.ts";

describe("isKnownLocale", () => {
  it.each(["en", "zh-TW", "zh_TW", "zh-Hant", "ja", "ko", "th", "vi", "id", "pt-BR"])(
    "accepts %s",
    (code) => expect(isKnownLocale(code)).toBe(true),
  );
  it.each(["common", "app", "messages", "xx", "", "not a tag"])("rejects %j", (code) =>
    expect(isKnownLocale(code)).toBe(false),
  );
});

describe("sameLocale", () => {
  it("ignores case and _ vs -", () => {
    expect(sameLocale("zh_TW", "zh-tw")).toBe(true);
    expect(sameLocale("zh-TW", "zh-CN")).toBe(false);
  });
});

describe("parseLocalePath", () => {
  it.each([
    ["locales/zh-TW.json", "zh-TW", "locales/{locale}.json"],
    ["lang/en.json", "en", "lang/{locale}.json"],
    ["src/i18n/messages/ja.json", "ja", "src/i18n/messages/{locale}.json"],
    ["public/locales/zh_TW/common.json", "zh_TW", "public/locales/{locale}/common.json"],
    [
      "apps/web/locales/ko/cart/checkout.json",
      "ko",
      "apps/web/locales/{locale}/cart/checkout.json",
    ],
  ])("recognises %s", (path, locale, template) => {
    expect(parseLocalePath(path)).toEqual({ path, locale, template });
  });

  it.each([
    "src/data/es.json", // looks like Spanish, but not under a locale directory
    "locales/README.md",
    "locales/common.json",
    "package.json",
    "locales/en.yaml",
  ])("ignores %s", (path) => {
    expect(parseLocalePath(path)).toBeUndefined();
  });

  it("accepts custom locale directories", () => {
    expect(parseLocalePath("strings/ja.json", ["strings"])?.locale).toBe("ja");
  });
});

/** parseLocalePath, but failing the test loudly instead of returning undefined. */
function localeFile(path: string) {
  const file = parseLocalePath(path);
  if (!file) throw new Error(`Not recognised as a locale file: ${path}`);
  return file;
}

describe("findSiblingLocales", () => {
  const reader = memoryReader({
    "locales/en.json": "{}",
    "locales/zh-TW.json": "{}",
    "locales/ja.json": "{}",
    "locales/schema.json": "{}",
    "public/locales/en/common.json": "{}",
    "public/locales/ja/common.json": "{}",
    "public/locales/ja/extra.json": "{}",
    "public/locales/shared/common.json": "{}",
  });

  it("finds the other locales of a flat layout", async () => {
    const siblings = await findSiblingLocales(localeFile("locales/zh-TW.json"), reader);
    expect(siblings.map((s) => s.path)).toEqual(["locales/en.json", "locales/ja.json"]);
  });

  it("finds the other locales of a directory-per-locale layout", async () => {
    const siblings = await findSiblingLocales(localeFile("public/locales/ja/common.json"), reader);
    expect(siblings.map((s) => s.path)).toEqual(["public/locales/en/common.json"]);
  });
});

describe("parseLocaleJson", () => {
  it("flattens nested and dotted keys and records where each key is", () => {
    const text = `{
  "cart": {
    "title": "Shopping cart",
    "items": "{count} items"
  },
  "checkout.pay": "Pay now",
  "count": 3
}`;
    const entries = parseLocaleJson("en.json", text);
    expect([...(entries?.values() ?? [])]).toEqual([
      { key: "cart.title", value: "Shopping cart", line: 3, column: 5 },
      { key: "cart.items", value: "{count} items", line: 4, column: 5 },
      { key: "checkout.pay", value: "Pay now", line: 6, column: 3 },
    ]);
  });

  it("returns undefined for invalid JSON or a non-object root", () => {
    expect(parseLocaleJson("en.json", `{ "a": "b", }`)).toBeUndefined();
    expect(parseLocaleJson("en.json", `["a"]`)).toBeUndefined();
  });
});

describe("extractPlaceholders", () => {
  const names = (message: string) => {
    const result = extractPlaceholders(message);
    return result.ok ? [...result.names] : result.error;
  };

  it("reads ICU arguments, including those nested in plural and select", () => {
    expect(names("Hi {name}, welcome back")).toEqual(["name"]);
    expect(names("{count, plural, one {# item} other {{name} has # items}}")).toEqual([
      "count",
      "name",
    ]);
    expect(names("{gender, select, female {She} other {They}} paid {total, number}")).toEqual([
      "gender",
      "total",
    ]);
    expect(names("{count, plural, other {{name}}}")).toEqual(["count", "name"]);
    expect(names("滿 {amount} 免運")).toEqual(["amount"]);
    expect(names("Don't miss it")).toEqual([]);
  });

  it("reads i18next interpolations", () => {
    expect(names("Hi {{name}}, you owe {{amount, currency}}")).toEqual(["name", "amount"]);
    expect(names("{{- html}} and {{ spaced }}")).toEqual(["html", "spaced"]);
  });

  it("reports broken ICU syntax instead of guessing", () => {
    expect(names("共 {count 件")).toBe("MALFORMED_ARGUMENT");
  });
});

describe("plural keys", () => {
  it("splits i18next plural suffixes", () => {
    expect(splitPluralKey("cart.item_one")).toEqual({
      base: "cart.item",
      ordinal: false,
      category: "one",
    });
    expect(splitPluralKey("place_ordinal_two")).toEqual({
      base: "place",
      ordinal: true,
      category: "two",
    });
    expect(splitPluralKey("cart.title")).toBeUndefined();
  });

  it("knows CJK, Thai and Vietnamese only need the 'other' form", () => {
    for (const locale of ["zh-TW", "ja", "ko", "th", "vi"]) {
      expect(isRequiredIn("item_one", locale)).toBe(false);
      expect(isRequiredIn("item_other", locale)).toBe(true);
    }
    expect(isRequiredIn("item_one", "en")).toBe(true);
    expect(isRequiredIn("item_few", "ru")).toBe(true);
    expect(isRequiredIn("cart.title", "ja")).toBe(true);
  });
});
