import { parseLocalePath } from "../locale/paths.ts";
import { isRequiredIn } from "../locale/plural.ts";
import { formatList, type LocaleRuleOptions, loadLocaleSet, lookup } from "../locale/set.ts";
import { closestMatch } from "../locale/suggest.ts";
import type { Finding, Rule } from "../types.ts";

// Keeps the keys of every locale file in sync with the source locale:
//  - a key in the source that another locale lacks → reported on the source line
//    (the missing key has no line of its own to comment on)
//  - a key in a translation that the source lacks → reported on that line (usually a typo)
// Plural forms a language does not have (e.g. "item_one" in Japanese) are not required.

export function createLocaleKeysRule(options: LocaleRuleOptions = {}): Rule {
  const id = "locale-keys";
  return {
    id,
    description: "Every locale should have the source locale's keys, and no others.",
    appliesTo: (path) => parseLocalePath(path, options.localeDirs) !== undefined,

    async check(file, { reader }) {
      const set = await loadLocaleSet(file, reader, options);
      if (!set?.source) return [];
      const { self, others, source } = set;
      const findings: Finding[] = [];

      if (self === source) {
        for (const entry of self.entries.values()) {
          const missing = others
            .filter((o) => isRequiredIn(entry.key, o.file.locale) && !o.entries.has(entry.key))
            .map((o) => o.file.locale)
            .sort();
          if (missing.length === 0) continue;
          findings.push({
            ruleId: id,
            path: file.path,
            line: entry.line,
            column: entry.column,
            severity: "warning",
            text: `missing:${entry.key}`,
            message: `Key "${entry.key}" is missing from ${formatList(missing)}. Users of ${missing.length === 1 ? "that language" : "those languages"} will see the fallback language or the raw key instead.`,
          });
        }
        return findings;
      }

      for (const entry of self.entries.values()) {
        if (lookup(source.entries, entry.key)) continue;
        const suggestion = closestMatch(entry.key, source.entries.keys());
        findings.push({
          ruleId: id,
          path: file.path,
          line: entry.line,
          column: entry.column,
          severity: "warning",
          text: `unknown:${entry.key}`,
          message: `Key "${entry.key}" does not exist in the source locale (${source.file.path}), so it is never used. ${
            suggestion
              ? `Did you mean "${suggestion}"?`
              : "Was it removed from the source, or is it a typo?"
          }`,
        });
      }
      return findings;
    },
  };
}
