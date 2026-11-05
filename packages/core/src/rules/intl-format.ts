import { NodeTypes, type TemplateChildNode } from "@vue/compiler-dom";
import { type CallExpression, Node, Project, SyntaxKind } from "ts-morph";
import type { Finding, Rule, SourceFile } from "../types.ts";
import { parseVueFile } from "../vue/sfc.ts";

// Numbers, dates and money look different in every locale:
//   1234567.891 → 1,234,567.891 (zh-TW, en-US) · 1.234.567,891 (vi-VN, de-DE)
//   4 Nov 2026  → 2026/11/4 (zh-TW, ja-JP) · 2026. 11. 4. (ko-KR) · 4/11/2569 (th-TH, Buddhist era)
//   1234.5 JPY  → ￥1,235 (no decimals) · 1234.5 VND → 1.235 ₫ (symbol after the number)
// Intl.NumberFormat / Intl.DateTimeFormat know all of this. This rule flags code that bypasses
// them, or calls them without saying which locale to use.

const CODE_FILE = /\.(jsx|tsx|js|mjs|cjs|ts|mts|cts|vue)$/;
const VUE_FILE = /\.vue$/;
const NON_PRODUCT_FILE = /\.(test|spec|stories)\.([cm]?[jt]sx?|vue)$|(^|\/)__tests__\//;
const ID = "intl-format";

const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const INTL_CONSTRUCTORS = new Set([
  "DateTimeFormat",
  "NumberFormat",
  "RelativeTimeFormat",
  "ListFormat",
  "PluralRules",
  "DisplayNames",
]);
const DATE_GETTER = /^get(UTC)?(FullYear|Month|Date|Day|Hours|Minutes)$/;
/** A currency symbol at the end of a literal, right before an interpolated number. */
const CURRENCY_BEFORE_NUMBER = /(?:(?:NT|US|HK|S|A|C|R)?\$|[¥￥€£₩฿₫₱₹])\s*$/;

/** Looks at one file only, so it can run synchronously and needs no RuleContext. */
export interface IntlFormatRule extends Rule {
  check(file: SourceFile): Finding[];
}

export function createIntlFormatRule(): IntlFormatRule {
  return {
    id: ID,
    description: "Numbers, dates and money should be formatted with Intl and an explicit locale.",
    appliesTo: (path) => CODE_FILE.test(path) && !NON_PRODUCT_FILE.test(path),

    check(file) {
      if (!VUE_FILE.test(file.path)) {
        const inJsx = (node: Node) =>
          node.getFirstAncestorByKind(SyntaxKind.JsxExpression) !== undefined;
        return checkCode(file.path, file.path, file.content, inJsx);
      }
      // A Vue component: <script> blocks and template expressions, in the shadow TypeScript
      // file; {{ … }}, v-text, v-html and user-facing bound attributes count as rendered.
      const vue = parseVueFile(file.content);
      const rendered = (node: Node) =>
        vue.rendered.some(([start, end]) => node.getStart() >= start && node.getStart() < end);
      const shadowPath = `${file.path}.${vue.shadowExtension}`;
      return [
        ...checkCode(file.path, shadowPath, vue.shadow, rendered),
        ...currencyInTemplate(file, vue.template),
      ].sort((x, y) => x.line - y.line || x.column - y.column);
    },
  };
}

/** The checks, on TypeScript/JavaScript code; `isRendered` says whether a node is shown. */
function checkCode(
  path: string,
  virtualPath: string,
  content: string,
  isRendered: (node: Node) => boolean,
): Finding[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(virtualPath, content);
  const findings: Finding[] = [];
  const report = (node: Node, kind: string, message: string) => {
    const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
    const snippet = node.getText().replace(/\s+/g, " ").slice(0, 80);
    findings.push({
      ruleId: ID,
      path,
      line,
      column,
      severity: "warning",
      text: `${kind}:${snippet}`,
      message,
    });
  };

  sourceFile.forEachDescendant((node) => {
    // date.toLocaleDateString(), amount.toLocaleString()
    if (Node.isCallExpression(node)) {
      const method = calledMethod(node);
      if (method && LOCALE_METHODS.has(method) && node.getArguments().length === 0) {
        report(
          node,
          "no-locale",
          `${method}() without a locale uses the default locale of whatever runs the code: the server's during server-side rendering, so the same page can show different formats (and React can report a hydration mismatch). Pass the user's locale, e.g. ${method}(locale).`,
        );
      }
      if (method === "toFixed" && isRendered(node)) {
        report(
          node,
          "to-fixed",
          'toFixed() always uses "." and no thousands separators, and fixes the number of decimals for every currency. Format displayed numbers with Intl.NumberFormat(locale, …) instead.',
        );
      }
    }

    // new Intl.NumberFormat(), new Intl.DateTimeFormat(undefined, …)
    if (Node.isNewExpression(node) || Node.isCallExpression(node)) {
      const formatter = intlConstructor(node.getExpression());
      const [locale] = node.getArguments();
      if (formatter && (!locale || locale.getText() === "undefined")) {
        report(
          node,
          "no-locale",
          `Intl.${formatter} without a locale uses the default locale of whatever runs the code. Pass the user's locale as the first argument.`,
        );
      }
    }

    // `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, or the same with +
    if (isHandBuiltDate(node)) {
      report(
        node,
        "manual-date",
        "This date is assembled by hand, but the order, separators and even the calendar differ by locale: 2026/11/4 (zh-TW), 11/4/2026 (en-US), 2026. 11. 4. (ko-KR), 4/11/2569 (th-TH). Use Intl.DateTimeFormat(locale, …).",
      );
    }

    // <span>NT${price}</span>, `$${price}`, "¥" + price
    const symbol = currencyBeforeNumber(node);
    if (symbol) {
      report(node, "currency", currencyMessage(symbol));
    }
  });

  return findings;
}

function calledMethod(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
}

/** "NumberFormat" for `Intl.NumberFormat`, otherwise undefined. */
function intlConstructor(expression: Node): string | undefined {
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  const name = expression.getName();
  return expression.getExpression().getText() === "Intl" && INTL_CONSTRUCTORS.has(name)
    ? name
    : undefined;
}

function countDateGetterCalls(node: Node): number {
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => DATE_GETTER.test(calledMethod(call) ?? "")).length;
}

function isHandBuiltDate(node: Node): boolean {
  if (Node.isTemplateExpression(node)) return countDateGetterCalls(node) >= 2;
  // Only the outermost `a + b + c`, so a chain is reported once.
  if (isStringConcatenation(node) && !isStringConcatenation(node.getParent())) {
    return countDateGetterCalls(node) >= 2;
  }
  return false;
}

function isStringConcatenation(node: Node | undefined): boolean {
  return (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.PlusToken &&
    node.getDescendantsOfKind(SyntaxKind.StringLiteral).length > 0
  );
}

function currencyBeforeNumber(node: Node): string | undefined {
  // JSX: text ending in a symbol, immediately followed by {expression}
  if (Node.isJsxText(node) && Node.isJsxExpression(node.getNextSibling())) {
    return CURRENCY_BEFORE_NUMBER.exec(node.getText())?.[0].trim();
  }
  // Template literal: a literal part ending in a symbol, right before ${…}
  if (Node.isTemplateExpression(node)) {
    const literals = [
      node.getHead(),
      ...node
        .getTemplateSpans()
        .slice(0, -1)
        .map((s) => s.getLiteral()),
    ];
    for (const literal of literals) {
      const match = CURRENCY_BEFORE_NUMBER.exec(literal.getLiteralText());
      if (match) return match[0].trim();
    }
  }
  // "NT$" + price
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = node.getLeft();
    if (Node.isStringLiteral(left)) {
      return CURRENCY_BEFORE_NUMBER.exec(left.getLiteralText())?.[0].trim();
    }
  }
  return undefined;
}

function currencyMessage(symbol: string): string {
  return `The currency symbol "${symbol}" is written by hand next to a number. Symbol, position and decimals vary by locale and currency (￥1,235 · 1.235 ₫ · $1,234.50). Use Intl.NumberFormat(locale, { style: "currency", currency }).`;
}

/** <span>NT$ {{ price }}</span>: template text ending in a currency symbol, then {{ … }}. */
function currencyInTemplate(file: SourceFile, template: TemplateChildNode[]): Finding[] {
  const findings: Finding[] = [];
  const visit = (children: TemplateChildNode[]) => {
    children.forEach((node, i) => {
      if (node.type === NodeTypes.ELEMENT) visit(node.children);
      if (node.type !== NodeTypes.TEXT || children[i + 1]?.type !== NodeTypes.INTERPOLATION) return;
      const match = CURRENCY_BEFORE_NUMBER.exec(node.loc.source);
      if (!match) return;
      const offset =
        node.loc.start.offset + match.index + match[0].length - match[0].trimStart().length;
      const before = file.content.slice(0, offset);
      findings.push({
        ruleId: ID,
        path: file.path,
        line: before.split("\n").length,
        column: offset - before.lastIndexOf("\n"),
        severity: "warning",
        text: `currency:${node.loc.source.trim().slice(0, 80)}`,
        message: currencyMessage(match[0].trim()),
      });
    });
  };
  visit(template);
  return findings;
}
