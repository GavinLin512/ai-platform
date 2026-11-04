import type { RepoReader, SourceFile } from "../types.ts";
import { type LocaleEntry, parseLocaleJson } from "./json.ts";
import { findSiblingLocales, type LocaleFile, parseLocalePath, sameLocale } from "./paths.ts";
import { splitPluralKey } from "./plural.ts";

export interface LocaleRuleOptions {
  /** The locale translators translate from. Default "en". */
  sourceLocale?: string;
  /** Directory names that contain locale files. Default: DEFAULT_LOCALE_DIRS. */
  localeDirs?: string[];
}

export interface LoadedLocale {
  file: LocaleFile;
  entries: Map<string, LocaleEntry>;
}

export interface LocaleSet {
  /** The changed file being checked. */
  self: LoadedLocale;
  /** Every other locale with a file for the same template (e.g. all of locales/*.json). */
  others: LoadedLocale[];
  /** The source locale's file; may be `self`. Undefined when the repository has none. */
  source?: LoadedLocale;
}

export async function loadLocaleSet(
  file: SourceFile,
  reader: RepoReader,
  options: LocaleRuleOptions,
): Promise<LocaleSet | undefined> {
  const localeFile = parseLocalePath(file.path, options.localeDirs);
  const entries = localeFile && parseLocaleJson(file.path, file.content);
  if (!localeFile || !entries) return undefined;

  const self: LoadedLocale = { file: localeFile, entries };
  const others: LoadedLocale[] = [];
  for (const sibling of await findSiblingLocales(localeFile, reader)) {
    const content = await reader.readFile(sibling.path);
    const siblingEntries =
      content === undefined ? undefined : parseLocaleJson(sibling.path, content);
    if (siblingEntries) others.push({ file: sibling, entries: siblingEntries });
  }

  const sourceLocale = options.sourceLocale ?? "en";
  const source = [self, ...others].find((l) => sameLocale(l.file.locale, sourceLocale));
  return { self, others, source };
}

/**
 * The entry for `key`; for an i18next plural form a locale does not have
 * (e.g. Russian "item_few" against English), fall back to its "other" form.
 */
export function lookup(entries: Map<string, LocaleEntry>, key: string): LocaleEntry | undefined {
  const exact = entries.get(key);
  if (exact) return exact;
  const plural = splitPluralKey(key);
  return plural && entries.get(`${plural.base}_${plural.ordinal ? "ordinal_" : ""}other`);
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** ["ja", "ko", "zh-TW"] → "ja, ko, and zh-TW" */
export function formatList(items: string[]): string {
  return listFormat.format(items);
}
