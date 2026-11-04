import { describe, expect, it } from "vitest";
import { type Finding, fingerprint, runRules } from "../../src/core/index.ts";

const cart = `export const Cart = () => (
  <div>
    <h1>Shopping cart</h1>
    <button>Checkout</button>
  </div>
);`;

describe("runRules", () => {
  it("reports every finding when no diff is given", async () => {
    const findings = await runRules([{ path: "src/Cart.tsx", content: cart }]);
    expect(findings.map((f) => f.text)).toEqual(["Shopping cart", "Checkout"]);
  });

  it("keeps only findings on added lines", async () => {
    const findings = await runRules([
      { path: "src/Cart.tsx", content: cart, addedLines: new Set([4]) },
    ]);
    expect(findings.map((f) => f.text)).toEqual(["Checkout"]);
  });

  it("skips files no rule applies to", async () => {
    expect(await runRules([{ path: "README.md", content: "<p>Hello</p>" }])).toEqual([]);
  });

  it("sorts findings by path, then line", async () => {
    const findings = await runRules([
      { path: "src/b.tsx", content: "const B = () => <p>B</p>;" },
      {
        path: "src/a.tsx",
        content: "const A = () => (\n  <div>\n    <p>A2</p>\n    <p>A1</p>\n  </div>\n);",
      },
    ]);
    expect(findings.map((f) => `${f.path}:${f.line}`)).toEqual([
      "src/a.tsx:3",
      "src/a.tsx:4",
      "src/b.tsx:1",
    ]);
  });
});

describe("fingerprint", () => {
  const base: Finding = {
    ruleId: "no-hardcoded-string",
    path: "src/Cart.tsx",
    line: 10,
    column: 5,
    severity: "warning",
    message: "…",
    text: "Checkout",
  };

  it("ignores the line number, so moved code is not re-reported", () => {
    expect(fingerprint({ ...base, line: 42, column: 1 })).toBe(fingerprint(base));
  });

  it("differs when the text, path or rule differs", () => {
    const original = fingerprint(base);
    expect(fingerprint({ ...base, text: "Pay now" })).not.toBe(original);
    expect(fingerprint({ ...base, path: "src/Other.tsx" })).not.toBe(original);
    expect(fingerprint({ ...base, ruleId: "other-rule" })).not.toBe(original);
  });
});
