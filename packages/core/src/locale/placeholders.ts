import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { parseVueI18nMessage } from "./vue-i18n.ts";

// Placeholder syntaxes:
//   ICU MessageFormat (react-intl, next-intl, FormatJS): "Hi {name}",
//     "{count, plural, one {# item} other {# items}}"
//   i18next: "Hi {{name}}", "{{price, currency}}"
//   vue-i18n: "Hi {name}", "{0}", "no apples | {count} apples", "@:other.key" (see vue-i18n.ts).
//     It looks like ICU but is not, so it is used only when the project depends on vue-i18n.
// ICU needs a real parser: arguments nest inside plural/select branches, and "#" is not an argument.

export type PlaceholderSyntax = "icu" | "i18next" | "vue-i18n";

export type Placeholders =
  | { ok: true; syntax: PlaceholderSyntax; names: Set<string> }
  | { ok: false; error: string; hint?: string };

const I18NEXT = /\{\{\s*-?\s*([^,}\s]+)[^}]*\}\}/g;

export function extractPlaceholders(message: string, format?: "vue-i18n"): Placeholders {
  if (format === "vue-i18n") {
    const parsed = parseVueI18nMessage(message);
    return parsed.ok
      ? { ok: true, syntax: "vue-i18n", names: parsed.names }
      : { ok: false, error: parsed.error, hint: parsed.hint };
  }
  // Try ICU first. "{{" alone is not proof of i18next: an ICU plural branch can start with an
  // argument, as in "other {{name} has # items}". Real i18next "{{name}}" never parses as ICU.
  try {
    const names = new Set<string>();
    collectIcuArguments(parse(message, { ignoreTag: true }), names);
    return { ok: true, syntax: "icu", names };
  } catch (error) {
    const i18next = [...message.matchAll(I18NEXT)].map((m) => m[1] as string);
    if (i18next.length > 0) return { ok: true, syntax: "i18next", names: new Set(i18next) };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function collectIcuArguments(elements: MessageFormatElement[], names: Set<string>): void {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        names.add(element.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        names.add(element.value);
        for (const option of Object.values(element.options))
          collectIcuArguments(option.value, names);
        break;
      case TYPE.tag:
        collectIcuArguments(element.children, names);
        break;
      // literal and "#" (pound) carry no argument names
    }
  }
}

export function formatPlaceholder(name: string, syntax: PlaceholderSyntax): string {
  return syntax === "i18next" ? `{{${name}}}` : `{${name}}`;
}
