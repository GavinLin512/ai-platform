import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

// The parts of a Markdown document that two language versions of it should share, each with
// the line it starts on. Prose is translated; the skeleton around it (sections, lists, code,
// links, metadata) is not, so comparing skeletons finds a version that was left behind.

export interface Position {
  line: number;
  column: number;
  /** Last line of a multi-line element (a list, a code block, a front matter value). */
  endLine?: number;
}

export interface FrontMatterField extends Position {
  key: string;
  value: unknown;
}

export interface Heading extends Position {
  depth: number;
  text: string;
}

export interface CodeBlock extends Position {
  lang: string | undefined;
  lines: string[];
  /** Line number of the first line of code (after the opening fence, if any). */
  firstLine: number;
}

export interface List extends Position {
  items: number;
}

export interface Link extends Position {
  url: string;
}

export interface MarkdownOutline {
  /** Undefined when there is none, or when it is not valid YAML (nothing to compare then). */
  frontMatter?: Map<string, FrontMatterField>;
  headings: Heading[];
  codeBlocks: CodeBlock[];
  lists: List[];
  /** Links, images and link reference definitions, in document order. */
  links: Link[];
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function outlineMarkdown(text: string): MarkdownOutline {
  const match = FRONT_MATTER.exec(text);
  const frontMatter = match ? parseFrontMatter(match[1] as string) : undefined;
  // Blank out the front matter but keep its line breaks, so every position the Markdown
  // parser reports is already a line number in the original file.
  const body = match ? match[0].replace(/[^\n]/g, "") + text.slice(match[0].length) : text;
  const sourceLines = text.split("\n");

  const outline: MarkdownOutline = {
    frontMatter,
    headings: [],
    codeBlocks: [],
    lists: [],
    links: [],
  };
  const visit = (node: Nodes) => {
    const start = node.position?.start ?? { line: 1, column: 1 };
    const at = { line: start.line, column: start.column, endLine: node.position?.end.line };
    switch (node.type) {
      case "heading":
        outline.headings.push({ ...at, depth: node.depth, text: plainText(node).trim() });
        break;
      case "code": {
        const fenced = /^\s*(`{3,}|~{3,})/.test(sourceLines[start.line - 1] ?? "");
        outline.codeBlocks.push({
          ...at,
          lang: node.lang ?? undefined,
          lines: node.value === "" ? [] : node.value.split("\n"),
          firstLine: fenced ? start.line + 1 : start.line,
        });
        break;
      }
      case "list":
        outline.lists.push({ ...at, items: node.children.length });
        break;
      case "link":
      case "image":
      case "definition":
        outline.links.push({ ...at, url: node.url });
        break;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(body));
  return outline;
}

function parseFrontMatter(yaml: string): Map<string, FrontMatterField> | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter });
  if (document.errors.length > 0) return undefined;
  const fields = new Map<string, FrontMatterField>();
  if (!isMap(document.contents)) return fields;
  const values = (document.toJS() ?? {}) as Record<string, unknown>;
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const { line, col } = lineCounter.linePos(pair.key.range?.[0] ?? 0);
    const valueEnd = (pair.value as { range?: [number, number, number] } | null)?.range?.[1];
    const end = valueEnd === undefined ? line : lineCounter.linePos(Math.max(valueEnd - 1, 0)).line;
    // +1: the YAML starts on the line after the opening "---".
    fields.set(key, { key, value: values[key], line: line + 1, column: col, endLine: end + 1 });
  }
  return fields;
}

function plainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}
