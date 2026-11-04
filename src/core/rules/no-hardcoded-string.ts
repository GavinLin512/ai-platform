import { Node, Project, SyntaxKind } from "ts-morph";
import type { Finding, Rule } from "../types.ts";

// Flags user-facing strings written directly in JSX instead of going through i18n.
//
// We deliberately check only places that are *almost always* shown to users
// (JSX text, a few attributes, simple expressions inside JSX). A reviewer bot that
// cries wolf gets uninstalled, so precision beats recall here.

export interface NoHardcodedStringOptions {
  /** JSX attributes whose values are rendered to users. */
  attributes?: string[];
  /** Text inside these elements is skipped (e.g. <Trans> already handles i18n, <code> is code). */
  ignoreElements?: string[];
}

const DEFAULT_ATTRIBUTES = ["alt", "aria-label", "label", "placeholder", "title"];
const DEFAULT_IGNORE_ELEMENTS = ["Trans", "code", "kbd", "pre", "samp", "script", "style"];

const JSX_FILE = /\.(jsx|tsx)$/;
const NON_PRODUCT_FILE = /\.(test|spec|stories)\.[jt]sx$|(^|\/)__tests__\//;

const HTML_ENTITY = /&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
const ANY_LETTER = /\p{L}/u;

/** "Add to cart" → true; "—", "100%", "&nbsp;" → false. Works for every script, not just Latin. */
export function isTranslatable(text: string): boolean {
  return ANY_LETTER.test(text.replace(HTML_ENTITY, ""));
}

export function createNoHardcodedStringRule(options: NoHardcodedStringOptions = {}): Rule {
  const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);
  const ignoreElements = new Set(options.ignoreElements ?? DEFAULT_IGNORE_ELEMENTS);

  return {
    id: "no-hardcoded-string",
    description: "User-facing strings in JSX should be localized.",

    appliesTo: (path) => JSX_FILE.test(path) && !NON_PRODUCT_FILE.test(path),

    check(file) {
      const project = new Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile(file.path, file.content);
      const findings: Finding[] = [];

      const report = (pos: number, text: string) => {
        const { line, column } = sourceFile.getLineAndColumnAtPos(pos);
        findings.push({
          ruleId: "no-hardcoded-string",
          path: file.path,
          line,
          column,
          severity: "warning",
          text,
          message: `Hardcoded string "${preview(text)}" is shown to users but not localized. Move it to your locale files and render it with your i18n function, e.g. t("…").`,
        });
      };

      const reportLiteral = (node: Node) => {
        const text = staticText(node);
        if (text !== undefined && isTranslatable(text)) report(node.getStart(), text);
      };

      sourceFile.forEachDescendant((node) => {
        // <p>Add to cart</p>
        if (Node.isJsxText(node)) {
          if (node.containsOnlyTriviaWhiteSpaces() || isIgnored(node, ignoreElements)) return;
          const fullText = node.getFullText();
          const text = fullText.replace(/\s+/g, " ").trim();
          if (!isTranslatable(text)) return;
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
