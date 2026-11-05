import { CompileErrorCodes, createParser } from "@intlify/message-compiler";
import type { RepoReader } from "../types.ts";

// vue-i18n (and Nuxt's @nuxtjs/i18n) has its own message syntax. It looks like ICU for
// "Hello {name}", but it is not ICU:
//   {name} named, {0} list, %{name} Rails-style (deprecated): placeholders
//   {'@'} a literal; \@ \{ \} \| also escape, from vue-i18n 11.3
//   @:key, @.lower:key: a linked message, i.e. the text of another key
//   "no apples | one apple | {count} apples": plural forms
// So { } @ $ | are special. A plain "hi@example.com" does not compile: "@" starts a link.
// The parser here is vue-i18n's own, so a message is judged exactly as the site will.

/** Packages that mean a project's messages use vue-i18n syntax. */
const VUE_I18N_PACKAGES = ["vue-i18n", "petite-vue-i18n", "@nuxtjs/i18n", "@intlify/core-base"];

// NodeTypes in @intlify/message-compiler is a const enum, which exists in its types only.
const NAMED = 4;
const LIST = 5;

export type VueI18nMessage =
  | { ok: true; names: Set<string> }
  | { ok: false; error: string; hint: string };

export function parseVueI18nMessage(message: string): VueI18nMessage {
  const errors: { code: number; message: string }[] = [];
  const ast = createParser({ onError: (error) => errors.push(error) }).parse(message);
  const first = errors[0];
  if (first) return { ok: false, error: first.message, hint: hintFor(first.code) };

  const names = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    const { type } = node as { type?: number };
    if (type === NAMED) names.add(String((node as { key: string }).key));
    if (type === LIST) names.add(String((node as { index: number }).index));
    // Placeholders can sit anywhere: in plural cases, in a linked key (@:{'key'}, @:{name})…
    for (const [key, value] of Object.entries(node)) if (key !== "loc") visit(value);
  };
  visit(ast);
  return { ok: true, names };
}

function hintFor(code: number): string {
  switch (code) {
    case CompileErrorCodes.INVALID_LINKED_FORMAT:
    case CompileErrorCodes.UNEXPECTED_EMPTY_LINKED_KEY:
    case CompileErrorCodes.UNEXPECTED_EMPTY_LINKED_MODIFIER:
      return `"@" starts a linked message (@:key). For a literal @, as in an e-mail address, write {'@'}, or keep the address out of the message.`;
    case CompileErrorCodes.UNTERMINATED_CLOSING_BRACE:
    case CompileErrorCodes.UNBALANCED_CLOSING_BRACE:
    case CompileErrorCodes.EMPTY_PLACEHOLDER:
    case CompileErrorCodes.NOT_ALLOW_NEST_PLACEHOLDER:
      return `"{" and "}" mark placeholders such as {name}. For a literal brace, write {'{'} or {'}'}.`;
    default:
      return `The special characters are { } @ $ |; write them as literals, e.g. {'@'}.`;
  }
}

/**
 * Whether the locale file at `path` belongs to a vue-i18n project: the nearest package.json
 * above it lists vue-i18n, petite-vue-i18n, @nuxtjs/i18n or @intlify/core-base.
 */
export async function usesVueI18n(path: string, reader: RepoReader): Promise<boolean> {
  const parts = path.split("/").slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const text = await reader.readFile(dir ? `${dir}/package.json` : "package.json");
    if (text === undefined) continue;
    try {
      const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      const deps = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      };
      return VUE_I18N_PACKAGES.some((name) => name in deps);
    } catch {
      return false;
    }
  }
  return false;
}
