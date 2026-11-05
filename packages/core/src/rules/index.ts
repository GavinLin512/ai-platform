import type { Config } from "../config.ts";
import type { Rule } from "../types.ts";
import { createContentParityRule } from "./content-parity.ts";
import { createIntlFormatRule } from "./intl-format.ts";
import { createLocaleKeysRule } from "./locale-keys.ts";
import { createLocalePlaceholdersRule } from "./locale-placeholders.ts";
import { createNoHardcodedStringRule } from "./no-hardcoded-string.ts";

/** Every rule, configured from .l10nrc.yml. A rule set to `false` is left out. */
export function createRules(config: Config = {}): Rule[] {
  const settings = config.rules ?? {};
  const localeOptions = { sourceLocale: config.sourceLocale, localeDirs: config.localeDirs };
  const hardcoded = settings["no-hardcoded-string"];
  const parity = settings["content-parity"];

  const rules: [enabled: boolean, create: () => Rule][] = [
    [
      hardcoded !== false,
      () => createNoHardcodedStringRule(typeof hardcoded === "object" ? hardcoded : {}),
    ],
    [settings["locale-keys"] !== false, () => createLocaleKeysRule(localeOptions)],
    [settings["locale-placeholders"] !== false, () => createLocalePlaceholdersRule(localeOptions)],
    [settings["intl-format"] !== false, () => createIntlFormatRule()],
    [
      parity !== undefined,
      () =>
        createContentParityRule({
          ...(parity as NonNullable<typeof parity>),
          sourceLocale: config.sourceLocale,
        }),
    ],
  ];
  return rules.filter(([enabled]) => enabled).map(([, create]) => create());
}

export const defaultRules: Rule[] = createRules();
