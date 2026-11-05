// i18next stores plural forms as separate keys: "item_one", "item_other", "item_ordinal_few"…
// Which forms a language needs comes from CLDR: English has one/other, Russian adds few/many,
// and Chinese, Japanese, Korean, Thai and Vietnamese only have "other".
// So "item_one" missing from ja.json is correct, not a missing translation.

// Lazy base: in "place_ordinal_two" the base is "place", not "place_ordinal".
const PLURAL_KEY = /^(.+?)_(ordinal_)?(zero|one|two|few|many|other)$/;

export interface PluralKey {
  base: string;
  ordinal: boolean;
  category: Intl.LDMLPluralRule;
}

export function splitPluralKey(key: string): PluralKey | undefined {
  const match = PLURAL_KEY.exec(key);
  if (!match) return undefined;
  return {
    base: match[1] as string,
    ordinal: match[2] !== undefined,
    category: match[3] as Intl.LDMLPluralRule,
  };
}

export function pluralCategories(locale: string, ordinal: boolean): Set<Intl.LDMLPluralRule> {
  const rules = new Intl.PluralRules(locale.replace(/_/g, "-"), {
    type: ordinal ? "ordinal" : "cardinal",
  });
  return new Set(rules.resolvedOptions().pluralCategories);
}

/** Whether `locale` needs its own entry for `key`. Plural forms the language lacks are optional. */
export function isRequiredIn(key: string, locale: string): boolean {
  const plural = splitPluralKey(key);
  return !plural || pluralCategories(locale, plural.ordinal).has(plural.category);
}
