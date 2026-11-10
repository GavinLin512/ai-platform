import { describe, expect, it } from "vitest";
import {
  createIntlFormatRule,
  createNoHardcodedStringRule,
  isTranslatable,
  parseConfig,
  parseVueFile,
} from "../src/index.ts";

const sfc = (template: string, script = "") =>
  `<template>\n${template}\n</template>\n${script ? `\n<script setup lang="ts">\n${script}\n</script>\n` : ""}`;

const hardcoded = (content: string, options = {}) =>
  createNoHardcodedStringRule(options)
    .check({ path: "app/components/Cart.vue", content })
    .map(({ text, line, column }) => ({ text, line, column }));

const intl = (content: string) =>
  createIntlFormatRule()
    .check({ path: "app/pages/order.vue", content })
    .map(({ line, column, text }) => ({ line, column, kind: text.split(":")[0] }));

describe("parseVueFile", () => {
  it("builds a shadow TypeScript file with every position unchanged", () => {
    const source = sfc(
      "  <p :title=\"soldOut ? 'Sold out' : ''\">{{ price.toFixed(2) }}</p>",
      "const price = 1",
    );
    const vue = parseVueFile(source);
    expect(vue.shadow).toHaveLength(source.length);
    expect(vue.shadow.split("\n").length).toBe(source.split("\n").length);
    // Each expression sits where it was, as `;(…)`: the `)` replaces the space after it.
    const at = (text: string) => source.indexOf(text);
    expect(vue.shadow.slice(at("soldOut") - 2, at("soldOut"))).toBe(";(");
    expect(vue.shadow.slice(at("price.toFixed"), at("price.toFixed") + 17)).toBe(
      "price.toFixed(2))",
    );
    expect(vue.shadow.slice(at("const price"))).toMatch(/^const price = 1/);
    expect(vue.shadow).not.toContain("<p");
    // {{ … }} and a user-facing attribute are rendered text.
    expect(vue.rendered).toHaveLength(2);
  });

  it("leaves non-HTML templates alone", () => {
    expect(parseVueFile('<template lang="pug">\np Hello\n</template>\n').template).toEqual([]);
  });
});

describe("no-hardcoded-string in Vue templates", () => {
  it("finds text, user-facing attributes and string literals in expressions", () => {
    const source = sfc(
      [
        "  <form>",
        '    <input placeholder="Search products" :aria-label="\'Search\'" class="w-full">',
        "    <button>",
        "      Add to cart",
        "    </button>",
        "    <p>{{ soldOut ? 'Sold out' : price }}</p>",
        "    <p v-text=\"'Free shipping'\" />",
        "  </form>",
      ].join("\n"),
    );
    expect(hardcoded(source)).toEqual([
      { text: "Search products", line: 3, column: 25 },
      { text: "Search", line: 3, column: 55 },
      { text: "Add to cart", line: 5, column: 7 },
      { text: "Sold out", line: 7, column: 21 },
      { text: "Free shipping", line: 8, column: 16 },
    ]);
  });

  it("leaves translated, non-user-facing and ignored content alone", () => {
    const source = sfc(
      [
        "  <div>",
        "    <h1>{{ $t('cart.title') }}</h1>",
        "    <p v-t=\"'cart.empty'\">Your cart is empty</p>",
        '    <i18n-t keypath="cart.total" tag="p"><b>Total</b></i18n-t>',
        "    <span :class=\"open ? 'menu open' : 'menu'\">◇ — 100%</span>",
        "    <code>npm install</code> <kbd>Ctrl</kbd>",
        '    <a href="/resume.pdf">/resume.pdf</a> <span>@grayson</span>',
        "    <!-- a comment with words -->",
        "    <span>&nbsp;&copy; 2026</span>",
        "  </div>",
      ].join("\n"),
    );
    expect(hardcoded(source)).toEqual([]);
  });

  it("skips texts listed in ignoreText, such as brand names", () => {
    const source = sfc(
      "  <header><b>Grayson's Portfolio.</b> <span>EN</span> <i>menu</i></header>",
    );
    expect(hardcoded(source, { ignoreText: ["Grayson's Portfolio.", "EN"] })).toEqual([
      { text: "menu", line: 2, column: 58 },
    ]);
  });

  it("skips texts that match ignorePattern", () => {
    const source = sfc(
      '  <PageHeader label="— 06 / about" />\n  <p>— grayson, somewhere in taipei.</p>',
    );
    expect(hardcoded(source, { ignorePattern: "^— \\d+ /" })).toEqual([
      { text: "— grayson, somewhere in taipei.", line: 3, column: 6 },
    ]);
  });

  it("does not check <script>: strings there are often keys, not text", () => {
    expect(hardcoded(sfc("  <p>{{ label }}</p>", "const label = 'Checkout'"))).toEqual([]);
  });
});

describe("intl-format in Vue components", () => {
  it("checks the script and the template, with positions in the .vue file", () => {
    const source = sfc(
      [
        "  <p>{{ new Date(order.date).toLocaleDateString() }}</p>",
        "  <p>NT$ {{ order.total }}</p>",
        "  <p>{{ order.total.toFixed(2) }}</p>",
        '  <svg :width="(w * 2).toFixed(1)" />',
      ].join("\n"),
      "const label = new Intl.NumberFormat().format(1)\nconst x = (w / 3).toFixed(1)",
    );
    expect(intl(source)).toEqual([
      { line: 2, column: 9, kind: "no-locale" },
      { line: 3, column: 6, kind: "currency" },
      { line: 4, column: 9, kind: "to-fixed" },
      // In the script: Intl without a locale. toFixed() there and in :width is not shown text.
      { line: 9, column: 15, kind: "no-locale" },
    ]);
  });
});

describe("isTranslatable", () => {
  it.each(["/resume.pdf", "@grayson", "read.cv", "https://example.com/a?b=1", "hi@example.com"])(
    "treats the address %j as not translatable",
    (text) => expect(isTranslatable(text)).toBe(false),
  );
  it.each(["Email hi@example.com", "rss · /feed.xml", "Built with Node.js"])(
    "still treats %j as translatable",
    (text) => expect(isTranslatable(text)).toBe(true),
  );
});

describe("config", () => {
  it("accepts ignorePattern only when it is a valid regular expression", () => {
    const problems = (pattern: string) =>
      parseConfig(
        ".l10nrc.yml",
        `rules:\n  no-hardcoded-string:\n    ignorePattern: '${pattern}'\n`,
      ).problems;
    expect(problems("^— \\d+ /")).toEqual([]);
    expect(problems("([")).toMatchObject([
      { line: 3, message: expect.stringContaining("must be a valid regular expression") },
    ]);
  });

  it("accepts ignoreText for no-hardcoded-string", () => {
    const text = 'rules:\n  no-hardcoded-string:\n    ignoreText: [EN, "Grayson\'s Portfolio."]\n';
    expect(parseConfig(".l10nrc.yml", text).problems).toEqual([]);
  });
});
