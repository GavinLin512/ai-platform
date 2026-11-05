import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  createLocalePlaceholdersRule,
  memoryReader,
  runRules,
} from "../src/index.ts";
import { parseVueI18nMessage, usesVueI18n } from "../src/locale/vue-i18n.ts";

const json = (object: Record<string, unknown>) => JSON.stringify(object, null, 2);
const NUXT = json({
  dependencies: { nuxt: "^4.6.2" },
  devDependencies: { "@nuxtjs/i18n": "^10.0.0" },
});
const ZH = "i18n/locales/zh-TW.json";
const EN = "i18n/locales/en.json";

/** Reviews whole changed files (every line is new) in a repository with the given package.json. */
async function review(
  manifest: string | undefined,
  locales: Record<string, object>,
  changed: string[],
) {
  const repo: Record<string, string> = Object.fromEntries(
    Object.entries(locales).map(([path, messages]) => [
      path,
      json(messages as Record<string, unknown>),
    ]),
  );
  if (manifest) repo["package.json"] = manifest;
  const files: ChangedFile[] = changed.map((path) => ({ path, content: repo[path] as string }));
  const rule = createLocalePlaceholdersRule({ sourceLocale: "zh-TW", localeDirs: ["i18n"] });
  const findings = await runRules(files, { rules: [rule], reader: memoryReader(repo) });
  return findings.map(({ path, line, message }) => ({ path, line, message }));
}

describe("parseVueI18nMessage", () => {
  it.each([
    ["Hello {name}", ["name"]],
    ["{0} world", ["0"]],
    ["%{msg} world", ["msg"]],
    ["{account}{'@'}{domain}", ["account", "domain"]],
    ["no apples | one apple | {count} apples", ["count"]],
    ["@:common.appName 的首頁", []],
    ["Hello, @.lower:{'message.name'}! You have {count} new messages.", ["count"]],
    ["hi \\@ there, 50% off, $5", []],
  ])("finds the placeholders of %j", (message, names) => {
    expect(parseVueI18nMessage(message)).toEqual({ ok: true, names: new Set(names) });
  });

  it("explains messages vue-i18n cannot compile", () => {
    expect(parseVueI18nMessage("email · graysonlin512@gmail.com")).toMatchObject({
      ok: false,
      error: "Invalid linked format",
      hint: expect.stringContaining("write {'@'}"),
    });
    expect(parseVueI18nMessage("price {price")).toMatchObject({
      ok: false,
      hint: expect.stringContaining("{'{'}"),
    });
  });
});

describe("usesVueI18n", () => {
  it("reads the nearest package.json above the locale file", async () => {
    const reader = memoryReader({
      "package.json": json({ devDependencies: { turbo: "2" } }),
      "apps/web/package.json": json({ dependencies: { "vue-i18n": "^11.0.0" } }),
    });
    expect(await usesVueI18n("apps/web/locales/en.json", reader)).toBe(true);
    expect(await usesVueI18n("locales/en.json", reader)).toBe(false);
    expect(await usesVueI18n("locales/en.json", memoryReader({}))).toBe(false);
  });
});

describe("locale-placeholders in a vue-i18n project", () => {
  it("reports a message that does not compile, in any locale, with how to fix it", async () => {
    const findings = await review(
      NUXT,
      {
        [ZH]: { contact: { email: "email · graysonlin512@gmail.com" } },
        [EN]: { contact: { email: "email" } },
      },
      [ZH],
    );
    expect(findings).toEqual([
      {
        path: ZH,
        line: 3,
        message:
          '"contact.email" does not compile in vue-i18n (Invalid linked format), so the page shows the key instead. "@" starts a linked message (@:key). For a literal @, as in an e-mail address, write {\'@\'}, or keep the address out of the message.',
      },
    ]);
  });

  it("accepts vue-i18n syntax that is not valid ICU", async () => {
    const locales = {
      [ZH]: {
        mail: "寄信給 {account}{'@'}{domain}",
        apples: "{count} 個蘋果",
        home: "@:site.name 的首頁",
      },
      [EN]: {
        mail: "Write to {account}{'@'}{domain}",
        apples: "no apples | one apple | {count} apples",
        home: "@:site.name home",
      },
    };
    expect(await review(NUXT, locales, [ZH, EN])).toEqual([]);
    // In a project without vue-i18n, "@" is ordinary text: the e-mail address is fine there.
    const email = {
      [ZH]: { email: "graysonlin512@gmail.com" },
      [EN]: { email: "graysonlin512@gmail.com" },
    };
    expect(await review(undefined, email, [ZH])).toEqual([]);
    expect(await review(NUXT, email, [ZH])).toHaveLength(1);
  });

  it("still compares placeholders, named and list", async () => {
    const findings = await review(
      NUXT,
      {
        [ZH]: { hi: "你好，{name}", nth: "第 {0} 篇" },
        [EN]: { hi: "Hi, {nmae}", nth: "Post {1}" },
      },
      [EN],
    );
    expect(findings.map((f) => f.message)).toEqual([
      'Placeholders in "hi" don\'t match zh-TW: missing {name}, unknown {nmae}. Source: "你好，{name}"',
      'Placeholders in "nth" don\'t match zh-TW: missing {0}, unknown {1}. Source: "第 {0} 篇"',
    ]);
  });
});
