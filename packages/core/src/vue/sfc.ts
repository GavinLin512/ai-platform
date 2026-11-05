import {
  type ElementNode,
  NodeTypes,
  parse,
  type RootNode,
  type TemplateChildNode,
} from "@vue/compiler-dom";

// A Vue single-file component, prepared for the rules that already understand TypeScript.
//
// The "shadow" is a TypeScript file exactly as long as the .vue file, with every <script>
// block and every template expression ({{ … }}, :title="…") at its own offset and everything
// else blanked to spaces. Line breaks are kept, so a position in the shadow is the same line
// and column in the .vue file: rules written for .ts files run on it unchanged.

/** Attributes whose value is shown to users (the same default as the JSX rule). */
export const USER_FACING_ATTRIBUTES = ["alt", "aria-label", "label", "placeholder", "title"];

/** Directives whose expression is a plain JavaScript expression (v-for, v-on, v-slot are not). */
const EXPRESSION_DIRECTIVES = new Set(["bind", "text", "html", "if", "else-if", "show"]);

export interface VueFile {
  /** The children of the top-level <template> (none for a non-HTML template, e.g. Pug). */
  template: TemplateChildNode[];
  shadow: string;
  /** File extension for the shadow: "tsx" when a script block is JSX/TSX. */
  shadowExtension: "ts" | "tsx";
  /** Offset → offset just past the end, for every expression placed in the shadow. */
  expressions: Map<number, number>;
  /** [start, end) offsets of expressions whose value is rendered as text. */
  rendered: Array<[number, number]>;
}

export function parseVueFile(source: string): VueFile {
  let root: RootNode;
  try {
    root = parse(source, { parseMode: "sfc", onError: () => {} });
  } catch {
    root = { children: [] } as unknown as RootNode;
  }

  const chars = source.replace(/[^\n]/g, " ").split("");
  const copy = (start: number, end: number) => {
    for (let i = start; i < end; i++) chars[i] = source[i] as string;
  };
  let shadowExtension: VueFile["shadowExtension"] = "ts";
  let template: TemplateChildNode[] = [];
  const expressions = new Map<number, number>();
  const rendered: Array<[number, number]> = [];

  for (const block of root.children) {
    if (block.type !== NodeTypes.ELEMENT) continue;
    if (block.tag === "script") {
      const content = block.children[0];
      if (content?.type === NodeTypes.TEXT) copy(content.loc.start.offset, content.loc.end.offset);
      if (/^[jt]sx$/.test(attribute(block, "lang") ?? "")) shadowExtension = "tsx";
    }
    if (block.tag === "template" && (attribute(block, "lang") ?? "html") === "html") {
      template = block.children;
    }
  }

  // ;(expression) in place: two blank characters before it (the "{{" or the `="` of an
  // attribute) and one after it (the "}" or the closing quote) are always available.
  const place = (start: number, end: number, isRendered: boolean) => {
    if (start < 2 || end >= source.length) return;
    if ([chars[start - 2], chars[start - 1], chars[end]].includes("\n")) return;
    copy(start, end);
    chars[start - 2] = ";";
    chars[start - 1] = "(";
    chars[end] = ")";
    expressions.set(start, end);
    if (isRendered) rendered.push([start, end]);
  };
  const visit = (node: TemplateChildNode) => {
    if (
      node.type === NodeTypes.INTERPOLATION &&
      node.content.type === NodeTypes.SIMPLE_EXPRESSION
    ) {
      place(node.content.loc.start.offset, node.content.loc.end.offset, true);
    }
    if (node.type !== NodeTypes.ELEMENT) return;
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.DIRECTIVE || !EXPRESSION_DIRECTIVES.has(prop.name)) continue;
      if (prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION) continue;
      const argument = boundAttribute(prop);
      const isRendered =
        prop.name === "text" ||
        prop.name === "html" ||
        (argument !== undefined && USER_FACING_ATTRIBUTES.includes(argument));
      place(prop.exp.loc.start.offset, prop.exp.loc.end.offset, isRendered);
    }
    for (const child of node.children) visit(child);
  };
  for (const node of template) visit(node);

  return { template, shadow: chars.join(""), shadowExtension, expressions, rendered };
}

/** "title" for :title="…" and v-bind:title="…"; undefined for v-bind="obj" or :[dynamic]. */
export function boundAttribute(prop: ElementNode["props"][number]): string | undefined {
  if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== "bind") return undefined;
  const arg = prop.arg;
  return arg?.type === NodeTypes.SIMPLE_EXPRESSION && arg.isStatic ? arg.content : undefined;
}

function attribute(element: ElementNode, name: string): string | undefined {
  for (const prop of element.props) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === name) return prop.value?.content;
  }
  return undefined;
}
