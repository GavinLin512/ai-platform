import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";

// Two placeholder syntaxes cover most web projects:
//   ICU MessageFormat (react-intl, next-intl, FormatJS, vue-i18n): "Hi {name}",
//     "{count, plural, one {# item} other {# items}}"
//   i18next: "Hi {{name}}", "{{price, currency}}"
// ICU needs a real parser: arguments nest inside plural/select branches, and "#" is not an argument.

export type PlaceholderSyntax = "icu" | "i18next";

export type Placeholders =
  | { ok: true; syntax: PlaceholderSyntax; names: Set<string> }
  | { ok: false; error: string };

const I18NEXT = /\{\{\s*-?\s*([^,}\s]+)[^}]*\}\}/g;

export function extractPlaceholders(message: string): Placeholders {
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
