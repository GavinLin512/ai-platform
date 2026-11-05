import { ts } from "ts-morph";

export interface LocaleEntry {
  /** Dotted path: { "cart": { "title": … } } and { "cart.title": … } both give "cart.title". */
  key: string;
  value: string;
  /** 1-based position of the key, which is where a review comment should go. */
  line: number;
  column: number;
}

/**
 * Flattens a locale JSON file into its string entries, keeping each key's position.
 * JSON.parse cannot tell us line numbers, so we walk the TypeScript compiler's JSON AST,
 * which ts-morph already ships. Returns undefined for invalid JSON or a non-object root.
 */
export function parseLocaleJson(path: string, text: string): Map<string, LocaleEntry> | undefined {
  try {
    JSON.parse(text); // the TS parser is lenient; reject anything that isn't strict JSON first
  } catch {
    return undefined;
  }

  const sourceFile = ts.parseJsonText(path, text);
  const root = sourceFile.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) return undefined;

  const entries = new Map<string, LocaleEntry>();
  const walk = (object: ts.ObjectLiteralExpression, prefix: string) => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
      const key = prefix + property.name.text;
      const value = property.initializer;

      if (ts.isStringLiteral(value)) {
        const position = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile));
        entries.set(key, {
          key,
          value: value.text,
          line: position.line + 1,
          column: position.character + 1,
        });
      } else if (ts.isObjectLiteralExpression(value)) {
        walk(value, `${key}.`);
      }
      // Numbers, arrays and null are not translatable strings: ignore them.
    }
  };
  walk(root, "");
  return entries;
}
