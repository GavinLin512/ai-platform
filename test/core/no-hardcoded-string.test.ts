import { describe, expect, it } from "vitest";
import { createNoHardcodedStringRule, isTranslatable } from "../../src/core/index.ts";

const rule = createNoHardcodedStringRule();

function check(content: string, path = "src/Cart.tsx") {
  return rule.check({ path, content }).map(({ text, line, column }) => ({ text, line, column }));
}

describe("isTranslatable", () => {
  it.each([
    "Add to cart",
    "加入購物車",
    "カートに追加",
    "장바구니",
    "เพิ่มลงตะกร้า",
    "x",
    "NT$ 100 off",
  ])("treats %j as translatable", (text) => expect(isTranslatable(text)).toBe(true));

  it.each(["—", "100%", "|", "©", "&nbsp;", "&#169;", "  ", "42", "NT$", "US$ "])(
    "treats %j as not translatable",
    (text) => expect(isTranslatable(text)).toBe(false),
  );
});

describe("no-hardcoded-string", () => {
  describe("appliesTo", () => {
    it.each(["src/Cart.tsx", "app/page.jsx"])("checks %s", (path) => {
      expect(rule.appliesTo(path)).toBe(true);
    });

    it.each([
      "src/cart.ts",
      "src/Cart.test.tsx",
      "src/Cart.spec.jsx",
      "src/Cart.stories.tsx",
      "src/__tests__/Cart.tsx",
    ])("skips %s", (path) => {
      expect(rule.appliesTo(path)).toBe(false);
    });
  });

  it("flags JSX text, with the position of the first visible character", () => {
    const code = `export const Cart = () => (
  <button>
    Add to cart
  </button>
);`;
    expect(check(code)).toEqual([{ text: "Add to cart", line: 3, column: 5 }]);
  });

  it("flags CJK and other non-Latin text", () => {
    expect(check(`const A = () => <p>加入購物車</p>;`)).toMatchObject([{ text: "加入購物車" }]);
    expect(check(`const A = () => <p>ตะกร้าสินค้า</p>;`)).toMatchObject([{ text: "ตะกร้าสินค้า" }]);
  });

  it("collapses whitespace in multi-line text", () => {
    const code = `const A = () => (
  <p>
    Free shipping
    on orders over $50
  </p>
);`;
    expect(check(code)).toMatchObject([{ text: "Free shipping on orders over $50" }]);
  });

  it("flags user-facing attributes only", () => {
    const code = `const A = () => (
  <input placeholder="Search products" className="search-box" type="text" id="q" />
);`;
    expect(check(code)).toMatchObject([{ text: "Search products" }]);
  });

  it("flags string literals rendered through simple expressions", () => {
    const code = `const A = ({ soldOut, error, name, total }) => (
  <div>
    {"Hello"}
    {soldOut ? "Sold out" : "In stock"}
    {error && "Something went wrong"}
    {name ?? "Guest"}
    {"Total: " + total}
    {\`Hi \${name}, welcome back\`}
    <img alt={soldOut ? "Sold-out badge" : undefined} src="/badge.png" />
  </div>
);`;
    expect(check(code).map((f) => f.text)).toEqual([
      "Hello",
      "Sold out",
      "In stock",
      "Something went wrong",
      "Guest",
      "Total: ",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the rule reports interpolations as a literal "${…}"
      "Hi ${…}, welcome back",
      "Sold-out badge",
    ]);
  });

  it("ignores text that is already localized or is not text", () => {
    const code = `const A = ({ t, price, status }) => (
  <div className="cart">
    {t("cart.add")}
    <Trans i18nKey="cart.summary">You have items</Trans>
    <code>npm install</code>
    {status === "active" && <span>{price}</span>}
    <span>&nbsp;—&nbsp;</span>
    <span>{42}</span>
    {"·"}
  </div>
);`;
    expect(check(code)).toEqual([]);
  });

  it("ignores strings outside JSX", () => {
    const code = `const label = "Add to cart";
export function track() { console.log("clicked"); }`;
    expect(check(code)).toEqual([]);
  });

  it("supports custom options", () => {
    const custom = createNoHardcodedStringRule({
      attributes: ["tooltip"],
      ignoreElements: ["Brand"],
    });
    const code = `const A = () => (
  <div>
    <Brand>Shopee</Brand>
    <Icon tooltip="Remove item" title="not checked anymore" />
  </div>
);`;
    expect(custom.check({ path: "a.tsx", content: code }).map((f) => f.text)).toEqual([
      "Remove item",
    ]);
  });
});
