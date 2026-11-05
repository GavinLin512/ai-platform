import { NodeTypes, type TemplateChildNode } from "@vue/compiler-dom";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { Finding, Rule, SourceFile } from "../types.ts";
import { boundAttribute, parseVueFile, USER_FACING_ATTRIBUTES } from "../vue/sfc.ts";

// Flags user-facing strings written directly in JSX or in a Vue template instead of going
// through i18n.
//
// We deliberately check only places that are *almost always* shown to users
// (JSX text, a few attributes, simple expressions inside JSX). A reviewer bot that
// cries wolf gets uninstalled, so precision beats recall here.

export interface NoHardcodedStringOptions {
  /** JSX attributes whose values are rendered to users. */
  attributes?: string[];
  /** Text inside these elements is skipped (e.g. <Trans> already handles i18n, <code> is code). */
  ignoreElements?: string[];
  /** Exact texts that are never translated: brand and product names, a language switch's "EN". */
  ignoreText?: string[];
  /** A regular expression for texts that are never translated, e.g. "^— \\d+ /" for labels. */
  ignorePattern?: string;
}

const DEFAULT_ATTRIBUTES = USER_FACING_ATTRIBUTES;
// <Trans> (react-i18next) and <i18n-t> (vue-i18n) render translations themselves.
const DEFAULT_IGNORE_ELEMENTS = [
  "Trans",
  "i18n-t",
  "I18nT",
  "code",
  "kbd",
  "pre",
  "samp",
  "script",
  "style",
];

const JSX_FILE = /\.(jsx|tsx)$/;
const VUE_FILE = /\.vue$/;
const NON_PRODUCT_FILE = /\.(test|spec|stories)\.([jt]sx|vue)$|(^|\/)__tests__\//;

const HTML_ENTITY = /&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
/** NT$, US$, HK$…: currency symbols, not words (intl-format reports them instead). */
const CURRENCY_PREFIX = /\b[A-Z]{1,3}\$/g;
const ANY_LETTER = /\p{L}/u;
/**
 * Addresses, not words: URLs, e-mail addresses, @handles, /paths, file and domain names
 * ("resume.pdf", "read.cv"). Alone they are not translated; next to words they do not count.
 */
const ADDRESS =
  /\b[a-z][a-z\d+.-]*:\/\/\S*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<!\w)@[\w.-]+|(?<![\w/])\/[\w./-]*|\b[\w-]+(?:\.[\w-]+)+\b/gi;

/** "Add to cart" → true; "—", "100%", "&nbsp;", "NT$", "/resume.pdf" → false. Every script. */
export function isTranslatable(text: string): boolean {
  return ANY_LETTER.test(
    text.replace(HTML_ENTITY, "").replace(CURRENCY_PREFIX, "").replace(ADDRESS, ""),
  );
}

/** Looks at one file only, so it can run synchronously and needs no RuleContext. */
export interface NoHardcodedStringRule extends Rule {
  check(file: SourceFile): Finding[];
}

export function createNoHardcodedStringRule(
  options: NoHardcodedStringOptions = {},
): NoHardcodedStringRule {
  const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);
  const ignoreElements = new Set(options.ignoreElements ?? DEFAULT_IGNORE_ELEMENTS);
  const ignoreText = new Set(options.ignoreText ?? []);
  const ignorePattern = options.ignorePattern ? new RegExp(options.ignorePattern, "u") : undefined;
  const shouldReport = (text: string) =>
    isTranslatable(text) && !ignoreText.has(text) && !ignorePattern?.test(text);

  return {
    id: "no-hardcoded-string",
    description: "User-facing strings in JSX and Vue templates should be localized.",

    appliesTo: (path) =>
      (JSX_FILE.test(path) || VUE_FILE.test(path)) && !NON_PRODUCT_FILE.test(path),

    check(file) {
      if (VUE_FILE.test(file.path)) {
        return checkVueTemplate(file, attributes, ignoreElements, shouldReport);
      }
      const project = new Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile(file.path, file.content);
      const findings: Finding[] = [];

      const report = (pos: number, text: string) => {
        const { line, column } = sourceFile.getLineAndColumnAtPos(pos);
        findings.push(hardcoded(file.path, line, column, text, 't("…")'));
      };

      const reportLiteral = (node: Node) => {
        const text = staticText(node);
        if (text !== undefined && shouldReport(text)) report(node.getStart(), text);
      };

      sourceFile.forEachDescendant((node) => {
        // <p>Add to cart</p>
        if (Node.isJsxText(node)) {
          if (node.containsOnlyTriviaWhiteSpaces() || isIgnored(node, ignoreElements)) return;
          const fullText = node.getFullText();
          const text = fullText.replace(/\s+/g, " ").trim();
          if (!shouldReport(text)) return;
          const leadingWhitespace = fullText.length - fullText.trimStart().length;
          report(node.getPos() + leadingWhitespace, text);
          return;
        }

        // <p>{"Add to cart"}</p>, <p>{isSoldOut ? "Sold out" : price}</p>
        if (Node.isJsxExpression(node)) {
          const parent = node.getParent();
          const isChild = Node.isJsxElement(parent) || Node.isJsxFragment(parent);
          if (!isChild || isIgnored(node, ignoreElements)) return;
          for (const literal of userFacingLiterals(node.getExpression())) reportLiteral(literal);
          return;
        }

        // <input placeholder="Search products" />
        if (Node.isJsxAttribute(node)) {
          if (!attributes.has(node.getNameNode().getText()) || isIgnored(node, ignoreElements)) {
            return;
          }
          const initializer = node.getInitializer();
          if (Node.isStringLiteral(initializer)) reportLiteral(initializer);
          else if (Node.isJsxExpression(initializer)) {
            for (const literal of userFacingLiterals(initializer.getExpression())) {
              reportLiteral(literal);
            }
          }
        }
      });

      return findings;
    },
  };
}

function hardcoded(
  path: string,
  line: number,
  column: number,
  text: string,
  call: string,
): Finding {
  return {
    ruleId: "no-hardcoded-string",
    path,
    line,
    column,
    severity: "warning",
    text,
    message: `Hardcoded string "${preview(text)}" is shown to users but not localized. Move it to your locale files and render it with your i18n function, e.g. ${call}.`,
  };
}

/**
 * The Vue version of the checks above, on the template:
 *   <p>Add to cart</p>                       text
 *   <input placeholder="Search">             a user-facing attribute
 *   {{ soldOut ? "Sold out" : price }}       string literals in an interpolation
 *   :title="'Menu'", v-text="'Hi'"           string literals in a bound attribute, v-text, v-html
 * Elements with v-t (vue-i18n fills them in) and ignored elements are skipped with their children.
 */
function checkVueTemplate(
  file: SourceFile,
  attributes: ReadonlySet<string>,
  ignoreElements: ReadonlySet<string>,
  shouldReport: (text: string) => boolean,
): Finding[] {
  const vue = parseVueFile(file.content);
  if (vue.template.length === 0) return [];
  const project = new Project({ useInMemoryFileSystem: true });
  const shadow = project.createSourceFile(`${file.path}.${vue.shadowExtension}`, vue.shadow);
  // Each expression was placed as `;(expression)`: index the parentheses by where it starts.
  const expressionAt = new Map<number, Node>();
  shadow.forEachDescendantAsArray().forEach((node) => {
    if (!Node.isParenthesizedExpression(node)) return;
    const start = node.getStart() + 1;
    if (vue.expressions.has(start)) expressionAt.set(start, node.getExpression());
  });

  const findings: Finding[] = [];
  const report = (offset: number, text: string) => {
    const { line, column } = shadow.getLineAndColumnAtPos(offset);
    findings.push(hardcoded(file.path, line, column, text, '{{ $t("…") }}'));
  };
  const reportExpression = (start: number) => {
    for (const literal of userFacingLiterals(expressionAt.get(start))) {
      const text = staticText(literal);
      if (text !== undefined && shouldReport(text)) report(literal.getStart(), text);
    }
  };

  const visit = (node: TemplateChildNode, ignored: boolean) => {
    if (node.type === NodeTypes.TEXT) {
      const text = node.content.replace(/\s+/g, " ").trim();
      if (ignored || !shouldReport(text)) return;
      const raw = node.loc.source;
      report(node.loc.start.offset + raw.length - raw.trimStart().length, text);
      return;
    }
    if (node.type === NodeTypes.INTERPOLATION) {
      if (!ignored) reportExpression(node.content.loc.start.offset);
      return;
    }
    if (node.type !== NodeTypes.ELEMENT) return;

    const skip =
      ignored ||
      ignoreElements.has(node.tag) ||
      node.props.some((p) => p.type === NodeTypes.DIRECTIVE && p.name === "t");
    if (!skip) {
      for (const prop of node.props) {
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (!attributes.has(prop.name) || !prop.value) continue;
          const text = prop.value.content.replace(/\s+/g, " ").trim();
          if (!shouldReport(text)) continue;
          const quoted = /^["']/.test(prop.value.loc.source) ? 1 : 0;
          report(prop.value.loc.start.offset + quoted, text);
          continue;
        }
        if (!prop.exp) continue;
        const bound = boundAttribute(prop);
        const rendersText = prop.name === "text" || prop.name === "html";
        if (rendersText || (bound !== undefined && attributes.has(bound))) {
          reportExpression(prop.exp.loc.start.offset);
        }
      }
    }
    for (const child of node.children) visit(child, skip);
  };
  for (const node of vue.template) visit(node, false);
  return findings;
}

/**
 * Walks the small set of expression shapes whose string operands end up on screen.
 * Anything else (function calls, comparisons, object keys…) is ignored on purpose.
 */
function userFacingLiterals(expr: Node | undefined): Node[] {
  if (!expr) return [];

  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr) ||
    Node.isTemplateExpression(expr)
  ) {
    return [expr];
  }
  if (Node.isParenthesizedExpression(expr)) return userFacingLiterals(expr.getExpression());

  // cond ? "Sold out" : "In stock"
  if (Node.isConditionalExpression(expr)) {
    return [...userFacingLiterals(expr.getWhenTrue()), ...userFacingLiterals(expr.getWhenFalse())];
  }

  if (Node.isBinaryExpression(expr)) {
    switch (expr.getOperatorToken().getKind()) {
      // isError && "Something went wrong", name ?? "Guest"
      case SyntaxKind.AmpersandAmpersandToken:
      case SyntaxKind.BarBarToken:
      case SyntaxKind.QuestionQuestionToken:
        return userFacingLiterals(expr.getRight());
      // "Total: " + total
      case SyntaxKind.PlusToken:
        return [...userFacingLiterals(expr.getLeft()), ...userFacingLiterals(expr.getRight())];
    }
  }

  return [];
}

/** The human-readable text of a string-like literal; `${…}` stands in for interpolations. */
function staticText(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isTemplateExpression(node)) {
    const parts = node
      .getTemplateSpans()
      .map((span) => `\${…}${span.getLiteral().getLiteralText()}`);
    return node.getHead().getLiteralText() + parts.join("");
  }
  return undefined;
}

function isIgnored(node: Node, ignoreElements: ReadonlySet<string>): boolean {
  return node.getAncestors().some((ancestor) => {
    const tag = Node.isJsxElement(ancestor)
      ? ancestor.getOpeningElement().getTagNameNode().getText()
      : Node.isJsxSelfClosingElement(ancestor)
        ? ancestor.getTagNameNode().getText()
        : undefined;
    return tag !== undefined && ignoreElements.has(tag);
  });
}

function preview(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
