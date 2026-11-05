import type { RepoReader } from "../types.ts";

// Recognises locale files from their path, e.g.
//   locales/zh-TW.json                → locale "zh-TW", template "locales/{locale}.json"
//   public/locales/ja/common.json     → locale "ja",    template "public/locales/{locale}/common.json"
//   lang/en.json (Laravel)            → locale "en",    template "lang/{locale}.json"

export interface LocaleFile {
  path: string;
  /** As written in the path, e.g. "zh-TW" or "zh_TW". */
  locale: string;
  /** The path with the locale segment replaced by "{locale}". */
  template: string;
}

/**
 * A locale segment must sit somewhere below one of these directories. Without this guard,
 * any "es.json" or "id/…" in a repository would be mistaken for a translation file.
 */
export const DEFAULT_LOCALE_DIRS = [
  "i18n",
  "intl",
  "l10n",
  "lang",
  "langs",
  "locale",
  "locales",
  "messages",
  "translations",
];

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * True for real locale codes ("en", "zh-TW", "zh_TW", "pt-BR"), false for "common", "app"…
 * Uses the CLDR data built into Node, so no locale list has to be maintained by hand.
 */
export function isKnownLocale(code: string): boolean {
  try {
    return languageNames.of(code.replace(/_/g, "-")) !== undefined;
  } catch {
    return false; // not even a syntactically valid language tag
  }
}

/** "zh_TW" and "zh-tw" are the same locale. */
export function sameLocale(a: string, b: string): boolean {
  return a.replace(/_/g, "-").toLowerCase() === b.replace(/_/g, "-").toLowerCase();
}

export function parseLocalePath(
  path: string,
  localeDirs: readonly string[] = DEFAULT_LOCALE_DIRS,
): LocaleFile | undefined {
  if (!path.endsWith(".json")) return undefined;
  const segments = path.split("/");
  const dirs = new Set(localeDirs.map((d) => d.toLowerCase()));
  let underLocaleDir = false;

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const candidate = isLast ? segment.slice(0, -".json".length) : segment;

    if (underLocaleDir && isKnownLocale(candidate)) {
      const template = [...segments];
      template[index] = isLast ? "{locale}.json" : "{locale}";
      return { path, locale: candidate, template: template.join("/") };
    }
    if (dirs.has(segment.toLowerCase())) underLocaleDir = true;
  }
  return undefined;
}

/** Every other locale that has a file for the same template, e.g. all `locales/*.json`. */
export async function findSiblingLocales(
  file: LocaleFile,
  reader: RepoReader,
): Promise<LocaleFile[]> {
  const [parent, rest] = file.template.split("{locale}") as [string, string];
  const entries = await reader.listDir(parent.replace(/\/$/, ""));
  const siblings: LocaleFile[] = [];

  for (const entry of entries) {
    // "{locale}.json" in a directory of files, or "{locale}/…" in a directory of directories.
    const locale =
      rest === ".json"
        ? entry.type === "file" && entry.name.endsWith(".json") && entry.name.slice(0, -5)
        : entry.type === "dir" && entry.name;
    if (!locale || !isKnownLocale(locale) || sameLocale(locale, file.locale)) continue;
    siblings.push({ path: `${parent}${locale}${rest}`, locale, template: file.template });
  }
  return siblings;
}
