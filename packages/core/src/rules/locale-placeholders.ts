import type { LocaleEntry } from "../locale/json.ts";
import { parseLocalePath } from "../locale/paths.ts";
import {
  extractPlaceholders,
  formatPlaceholder,
  type Placeholders,
} from "../locale/placeholders.ts";
import {
  formatList,
  type LoadedLocale,
  type LocaleRuleOptions,
  loadLocaleSet,
  lookup,
} from "../locale/set.ts";
import type { Finding, Rule, RuleContext } from "../types.ts";

// A translation must use the same placeholders as its source string. "滿 {price} 免運" against
// "Free shipping over {amount}" renders a literal "{price}" (or nothing) in production.
//  - translation changed → compare it with the source, report on the translation's line
//  - source changed → report translations left behind, on the source line
// When both change in one PR, the issue is reported once, on the translation.

type ValidPlaceholders = Extract<Placeholders, { ok: true }>;

export function createLocalePlaceholdersRule(options: LocaleRuleOptions = {}): Rule {
  const id = "locale-placeholders";
  return {
    id,
    description: "Translations should use the same placeholders as the source string.",
    appliesTo: (path) => parseLocalePath(path, options.localeDirs) !== undefined,

    async check(file, { reader, changedFiles }) {
      const set = await loadLocaleSet(file, reader, options);
      if (!set?.source) return [];
      const { self, others, source } = set;
      const findings: Finding[] = [];
      const report = (entry: LocaleEntry, text: string, message: string) =>
        findings.push({
          ruleId: id,
          path: file.path,
          line: entry.line,
          column: entry.column,
          severity: "error",
          text,
          message,
        });

      if (self === source) {
        for (const entry of self.entries.values()) {
          const expected = extractPlaceholders(entry.value);
          if (!expected.ok) continue;

          const stale: string[] = [];
          for (const other of others) {
            const translation = lookup(other.entries, entry.key);
            if (!translation || isReportedOnItsOwnLine(other, translation, changedFiles)) continue;
            const problem = compare(expected, translation.value);
            if (problem) stale.push(`${other.file.locale} (${problem})`);
          }
          if (stale.length > 0) {
            report(
              entry,
              `${entry.key}:${stale.join(";")}`,
              `The placeholders of "${entry.key}" no longer match its translations: ${formatList(stale)}. Update the translations, or they will render the wrong values.`,
            );
          }
        }
        return findings;
      }

      for (const entry of self.entries.values()) {
        const original = lookup(source.entries, entry.key);
        const expected = original && extractPlaceholders(original.value);
        if (!expected?.ok) continue;
        const problem = compare(expected, entry.value);
        if (problem) {
          report(
            entry,
            `${entry.key}:${problem}`,
            `Placeholders in "${entry.key}" don't match ${source.file.locale}: ${problem}. Source: "${original?.value}"`,
          );
        }
      }
      return findings;
    },
  };
}

/** Describes how `translation` deviates from the expected placeholders, or undefined if it doesn't. */
function compare(expected: ValidPlaceholders, translation: string): string | undefined {
  const actual = extractPlaceholders(translation);
  const show = (names: string[], syntax = expected.syntax) =>
    names.map((name) => formatPlaceholder(name, syntax)).join(" ");

  if (!actual.ok) {
    // Only call it broken when the source proves the project uses ICU placeholders.
    if (expected.syntax === "icu" && expected.names.size > 0) {
      return `not a valid ICU message (${actual.error})`;
    }
    return expected.names.size > 0 ? `missing ${show([...expected.names])}` : undefined;
  }

  if (expected.names.size > 0 && actual.names.size > 0 && actual.syntax !== expected.syntax) {
    return `uses ${show([...actual.names], actual.syntax)} instead of ${show([...expected.names])}`;
  }

  const missing = [...expected.names].filter((name) => !actual.names.has(name));
  const unknown = [...actual.names].filter((name) => !expected.names.has(name));
  const problems = [
    missing.length > 0 && `missing ${show(missing)}`,
    unknown.length > 0 && `unknown ${show(unknown)}`,
  ].filter(Boolean);
  return problems.length > 0 ? problems.join(", ") : undefined;
}

/** True when that translation line is part of this change: it gets its own finding there. */
function isReportedOnItsOwnLine(
  locale: LoadedLocale,
  entry: LocaleEntry,
  changedFiles: RuleContext["changedFiles"],
): boolean {
  if (!changedFiles.has(locale.file.path)) return false;
  const addedLines = changedFiles.get(locale.file.path);
  return addedLines === undefined || addedLines.has(entry.line);
}
