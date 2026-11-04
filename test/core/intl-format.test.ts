import { describe, expect, it } from "vitest";
import { createIntlFormatRule } from "../../src/core/index.ts";

const rule = createIntlFormatRule();

function kinds(content: string, path = "src/Order.tsx") {
  return rule.check({ path, content }).map((f) => `${f.line}:${f.text.split(":")[0]}`);
}

describe("intl-format", () => {
  it("applies to code files other than tests and stories", () => {
    expect(rule.appliesTo("src/format.ts")).toBe(true);
    expect(rule.appliesTo("src/Order.tsx")).toBe(true);
    expect(rule.appliesTo("src/Order.test.tsx")).toBe(false);
    expect(rule.appliesTo("locales/en.json")).toBe(false);
  });

  it("flags locale-sensitive methods called without a locale", () => {
    const code = `export function show(date: Date, total: number, locale: string) {
  date.toLocaleDateString();
  total.toLocaleString();
  date.toLocaleTimeString(locale);
  return date.toLocaleDateString(locale, { dateStyle: "long" });
}`;
    expect(kinds(code, "src/format.ts")).toEqual(["2:no-locale", "3:no-locale"]);
  });

  it("flags Intl formatters created without a locale", () => {
    const code = `const a = new Intl.NumberFormat();
const b = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
const c = Intl.NumberFormat();
const d = new Intl.NumberFormat(locale, { style: "currency", currency: "TWD" });
const e = new Intl.Collator();`;
    expect(kinds(code, "src/format.ts")).toEqual(["1:no-locale", "2:no-locale", "3:no-locale"]);
  });

  it("flags dates assembled by hand, once per expression", () => {
    const code = `const a = \`\${d.getFullYear()}/\${d.getMonth() + 1}/\${d.getDate()}\`;
const b = d.getFullYear() + "/" + d.getMonth() + "/" + d.getDate();
const c = \`Year \${d.getFullYear()}\`;
const e = d.getTime() + 1000;`;
    expect(kinds(code, "src/format.ts")).toEqual(["1:manual-date", "2:manual-date"]);
  });

  it("flags toFixed() only when the result is rendered", () => {
    const code = `const rounded = price.toFixed(2);
export const Price = ({ price }) => <span>{price.toFixed(2)}</span>;`;
    expect(kinds(code)).toEqual(["2:to-fixed"]);
  });

  it("flags currency symbols written next to a number", () => {
    const code = `export const A = ({ price, total }) => (
  <div>
    <span>NT\${price}</span>
    <span>{\`¥\${total}\`}</span>
    <span>{"€" + total}</span>
    <span>Price: {price}</span>
    <span>{\`\${count} items\`}</span>
  </div>
);`;
    const findings = rule.check({ path: "src/A.tsx", content: code });
    expect(findings.map((f) => `${f.line}:${f.message.match(/"(.+?)"/)?.[1]}`)).toEqual([
      "3:NT$",
      "4:¥",
      "5:€",
    ]);
  });

  it("leaves correctly localized code alone", () => {
    const code = `const money = new Intl.NumberFormat(locale, { style: "currency", currency });
export const Total = ({ total, date }) => (
  <p>
    {money.format(total)} · {new Intl.DateTimeFormat(locale).format(date)}
  </p>
);`;
    expect(kinds(code)).toEqual([]);
  });
});
