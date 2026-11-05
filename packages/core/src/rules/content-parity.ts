import {
  type CodeBlock,
  type Heading,
  type List,
  type MarkdownOutline,
  outlineMarkdown,
  type Position,
} from "../content/markdown.ts";
import type { Finding, Rule, RuleContext, Severity } from "../types.ts";

// Keeps the language versions of a Markdown document (a blog post, a project page) in step.
// Prose is translated, but the skeleton is not: the same front matter values, the same
// sections, the same number of items in each list, the same code and the same links. When one
// version is edited and the other is not, the skeletons drift apart, and this rule says where.
//
// Code is compared line by line. Comments and output text in code are translated too, so a
// line may differ when either version of it contains letters of a non-Latin script (Chinese,
// Japanese, Thai…); a differing line without any is code that changed in only one version.
//
// Each difference is reported once, on a line the change added: in the translation if it can
// be (it is usually the version left behind), otherwise in the source. A file the change
// touched elsewhere does not count, or the finding would land on a line nobody can see.

export interface ContentPair {
  /** Directory of the originals, e.g. "content/blog". */
  source: string;
  /** Locale → directory of that locale's versions, e.g. { en: "content/i18n/en/blog" }. */
  translations: Record<string, string>;
}

export interface ContentParityOptions {
  pairs: ContentPair[];
  /** The language the originals are written in (from .l10nrc.yml). Default: en. */
  sourceLocale?: string;
  /** Front matter fields that are translated; every other field must match. */
  translatableFields?: string[];
}

export const DEFAULT_TRANSLATABLE_FIELDS = ["title", "subtitle", "description"];

const MARKDOWN = /\.(md|markdown|mdx)$/i;
/** A letter outside the Latin alphabet: the line contains text in an Asian (or other) script. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

type Side = "source" | "translation";
const opposite = (side: Side): Side => (side === "source" ? "translation" : "source");

/** Per version, the lines the change added: a set, "all" (new file, or not known), or
 *  undefined when the change did not touch that version. */
type Added = Record<Side, ReadonlySet<number> | "all" | undefined>;

interface Difference {
  severity: Severity;
  /** What the difference is, without line numbers, for de-duplication across pushes. */
  text: string;
  /** Where it is in each version. A difference is reported in a version it has a position in. */
  at: Partial<Record<Side, Position>>;
  /** The message, from the point of view of the version it is reported in. */
  message(side: Side): string;
}

interface Located {
  pair: ContentPair;
  side: Side;
  /** The translation's locale, when side is "translation". */
  locale?: string;
  /** Path below the pair's directory, the same in every version. */
  relative: string;
}

export function createContentParityRule(options: ContentParityOptions): Rule {
  const id = "content-parity";
  const sourceLocale = options.sourceLocale ?? "en";
  const translatable = new Set(options.translatableFields ?? DEFAULT_TRANSLATABLE_FIELDS);
  const pairs = options.pairs.map((pair) => ({
    source: normalize(pair.source),
    translations: Object.fromEntries(
      Object.entries(pair.translations).map(([locale, dir]) => [locale, normalize(dir)]),
    ),
  }));

  /** Which pair and side a path belongs to. The longest matching directory wins, so a
   *  translation directory may sit inside the source directory (content/ and content/en/). */
  function locate(path: string): Located | undefined {
    let best: (Located & { depth: number }) | undefined;
    const consider = (dir: string, found: Omit<Located, "relative">) => {
      if (!path.startsWith(`${dir}/`) || (best && best.depth >= dir.length)) return;
      best = { ...found, relative: path.slice(dir.length + 1), depth: dir.length };
    };
    for (const pair of pairs) {
      consider(pair.source, { pair, side: "source" });
      for (const [locale, dir] of Object.entries(pair.translations)) {
        consider(dir, { pair, side: "translation", locale });
      }
    }
    return best;
  }

  async function compare(
    current: string,
    paths: Record<Side, string>,
    texts: Record<Side, string | undefined>,
    locale: string,
    { changedFiles }: RuleContext,
  ): Promise<Finding[]> {
    const names: Record<Side, string> = { source: sourceLocale, translation: locale };
    const addedIn = (path: string) =>
      changedFiles.has(path) ? (changedFiles.get(path) ?? "all") : undefined;
    const added: Added = { source: addedIn(paths.source), translation: addedIn(paths.translation) };
    const differences: Difference[] = [];
    const top = { line: 1, column: 1 };
    if (texts.translation === undefined) {
      differences.push({
        severity: "info",
        text: "missing-translation",
        at: { source: top },
        message: () => `There is no ${locale} version of this file yet (${paths.translation}).`,
      });
    } else if (texts.source === undefined) {
      differences.push({
        severity: "warning",
        text: "missing-source",
        at: { translation: top },
        message: () =>
          `This is the ${locale} version of ${paths.source}, which does not exist. Was the original renamed or deleted?`,
      });
    } else {
      const lineByLine = usesNonLatinScript(sourceLocale) || usesNonLatinScript(locale);
      differences.push(
        ...compareOutlines(
          outlineMarkdown(texts.source),
          outlineMarkdown(texts.translation),
          names,
          translatable,
          lineByLine,
          added,
        ),
      );
    }

    const findings: Finding[] = [];
    for (const difference of differences) {
      const side = reportingSide(difference, added);
      const position = difference.at[side];
      if (paths[side] !== current || !position) continue;
      // On the element's first added line: a list that grew at the end is commented where
      // the new items are, not on its unchanged first line.
      const line = addedLineIn(position, added[side]) ?? position.line;
      findings.push({
        ruleId: id,
        path: current,
        line,
        column: line === position.line ? position.column : 1,
        severity: difference.severity,
        text: `${locale}:${difference.text}`,
        message: difference.message(side),
      });
    }
    return findings;
  }

  return {
    id,
    description: "Every language version of a document should share its structure and code.",
    appliesTo: (path) => MARKDOWN.test(path) && locate(path) !== undefined,

    async check(file, context) {
      const located = locate(file.path);
      if (!located) return [];
      const { pair, relative } = located;
      const sourcePath = `${pair.source}/${relative}`;

      if (located.side === "translation") {
        const locale = located.locale as string;
        const paths = { source: sourcePath, translation: file.path };
        const texts = {
          source: await context.reader.readFile(sourcePath),
          translation: file.content,
        };
        return compare(file.path, paths, texts, locale, context);
      }
      const findings: Finding[] = [];
      for (const [locale, dir] of Object.entries(pair.translations)) {
        const paths = { source: file.path, translation: `${dir}/${relative}` };
        const texts = {
          source: file.content,
          translation: await context.reader.readFile(paths.translation),
        };
        findings.push(...(await compare(file.path, paths, texts, locale, context)));
      }
      return findings;
    },
  };
}

/** The version where the difference sits on a line the change added, translation first. */
function reportingSide(difference: Difference, added: Added): Side {
  const touched = (side: Side) => addedLineIn(difference.at[side], added[side]) !== undefined;
  if (touched("translation")) return "translation";
  if (touched("source")) return "source";
  return difference.at.translation ? "translation" : "source";
}

/** The first line of the element that the change added (its first line in a new file). */
function addedLineIn(position: Position | undefined, lines: Added[Side]): number | undefined {
  if (!position || lines === undefined) return undefined;
  if (lines === "all") return position.line;
  for (let line = position.line; line <= (position.endLine ?? position.line); line++) {
    if (lines.has(line)) return line;
  }
  return undefined;
}

function compareOutlines(
  a: MarkdownOutline,
  b: MarkdownOutline,
  names: Record<Side, string>,
  translatable: Set<string>,
  lineByLine: boolean,
  added: Added,
): Difference[] {
  const other = (side: Side) =>
    `the ${names[side === "source" ? "translation" : "source"]} version`;
  const differences: Difference[] = [];

  // Front matter: everything except the translated fields must be equal.
  if (a.frontMatter && b.frontMatter) {
    const fa = a.frontMatter;
    const fb = b.frontMatter;
    for (const key of new Set([...fa.keys(), ...fb.keys()])) {
      if (translatable.has(key)) continue;
      const fields = { source: fa.get(key), translation: fb.get(key) };
      if (
        fields.source &&
        fields.translation &&
        same(fields.source.value, fields.translation.value)
      ) {
        continue;
      }
      differences.push({
        severity: "warning",
        text: `front-matter:${key}`,
        at: { source: fields.source, translation: fields.translation },
        message: (side) => {
          const here = fields[side];
          const there = fields[side === "source" ? "translation" : "source"];
          if (!there) return `"${key}" is set here but not in ${other(side)}.`;
          return `"${key}" is ${show(here?.value)} here but ${show(there.value)} in ${other(side)} (line ${there.line}). Only ${[...translatable].join(", ")} are translated; the other fields should be the same in every version.`;
        },
      });
    }
  }

  // Sections: the same number of headings, at the same levels.
  const headings = { source: a.headings, translation: b.headings };
  const label = (h: Heading) => `"${"#".repeat(h.depth)} ${h.text}"`;
  if (a.headings.length !== b.headings.length) {
    differences.push(
      countMismatch(
        headings,
        "heading",
        (i) => a.headings[i]?.depth === b.headings[i]?.depth,
        added,
        other,
      ),
    );
  } else {
    const i = firstIndex(a.headings.length, (k) => a.headings[k]?.depth === b.headings[k]?.depth);
    if (i !== undefined) {
      const at = { source: a.headings[i] as Heading, translation: b.headings[i] as Heading };
      differences.push({
        severity: "warning",
        text: `headings:${i}`,
        at,
        message: (side) =>
          `The section levels stop matching ${other(side)} here: this is heading ${i + 1} (${label(at[side])}), but heading ${i + 1} there is ${label(at[opposite(side)])} (line ${at[opposite(side)].line}). Was a section moved in only one version?`,
      });
    }
  }

  // Lists: the same number of lists, each with the same number of items.
  const lists = { source: a.lists, translation: b.lists };
  if (a.lists.length !== b.lists.length) {
    differences.push(
      countMismatch(lists, "list", (i) => a.lists[i]?.items === b.lists[i]?.items, added, other),
    );
  } else {
    a.lists.forEach((x, i) => {
      const at = { source: x, translation: b.lists[i] as List };
      if (x.items === at.translation.items) return;
      differences.push({
        severity: "warning",
        text: `list:${i}`,
        at,
        message: (side) =>
          `This list has ${plural(at[side].items, "item")}, but the matching list in ${other(side)} (line ${at[opposite(side)].line}) has ${at[opposite(side)].items}. Was an item added or removed in only one version?`,
      });
    });
  }

  // Code: the same blocks, the same lines.
  differences.push(...compareCode(a.codeBlocks, b.codeBlocks, names, other, lineByLine, added));

  // Links: the same targets (in any order: a translation may reorder a sentence).
  // In-page anchors (#…) are left out, since heading slugs are translated too.
  const urls = (outline: MarkdownOutline) =>
    new Map(
      outline.links
        .filter((l) => !l.url.startsWith("#"))
        .reverse()
        .map((l) => [l.url, l]),
    );
  const ua = urls(a);
  const ub = urls(b);
  for (const [side, mine, theirs] of [
    ["source", ua, ub],
    ["translation", ub, ua],
  ] as const) {
    for (const [url, link] of mine) {
      if (theirs.has(url)) continue;
      differences.push({
        severity: "info",
        text: `link:${url}`,
        at: { [side]: link },
        message: (s) => `This links to ${url}, but ${other(s)} does not.`,
      });
    }
  }

  return differences;
}

/**
 * One version has more sections, lists or code blocks than the other: which one is extra?
 * Prefer one this change added (a heading added to the version that now has more headings is
 * the likely culprit); without that hint, the first position where the two stop matching.
 */
function countMismatch<T extends Position>(
  items: Record<Side, T[]>,
  noun: string,
  matches: (i: number) => boolean,
  added: Added,
  other: (side: Side) => string,
): Difference {
  const counts = { source: items.source.length, translation: items.translation.length };
  const longer: Side = counts.source > counts.translation ? "source" : "translation";
  const text = `${noun}s:${counts.source}:${counts.translation}`;
  const tally = (side: Side) =>
    `this version has ${plural(counts[side], noun)}, ${other(side)} ${counts[opposite(side)]}`;

  const lines = added[longer];
  const index = lines instanceof Set ? items[longer].findIndex((item) => lines.has(item.line)) : -1;
  if (index >= 0) {
    return {
      severity: "warning",
      text,
      at: { [longer]: items[longer][index] },
      message: (side) =>
        `This ${noun} is new in this change, and ${other(side)} has no matching one (${tally(side)}). Was it left out of the other version?`,
    };
  }
  const i = firstIndex(Math.max(counts.source, counts.translation), matches) ?? 0;
  return {
    severity: "warning",
    text,
    at: { source: items.source[i], translation: items.translation[i] },
    message: (side) =>
      `The ${noun}s stop matching ${other(side)} at this one (${tally(side)}). Was one added or removed in only one version?`,
  };
}

function compareCode(
  a: CodeBlock[],
  b: CodeBlock[],
  names: Record<Side, string>,
  other: (side: Side) => string,
  lineByLine: boolean,
  added: Added,
): Difference[] {
  const differences: Difference[] = [];

  if (a.length !== b.length) {
    const blocks = { source: a, translation: b };
    const same = (k: number) => sameSkeleton(a[k], b[k], lineByLine);
    return [countMismatch(blocks, "code block", same, added, other)];
  }

  a.forEach((x, i) => {
    const y = b[i] as CodeBlock;
    const blocks = { source: x, translation: y };
    if (x.lang !== y.lang) {
      differences.push({
        severity: "warning",
        text: `code:${i}:lang`,
        at: blocks,
        message: (side) =>
          `This code block is marked ${blocks[side].lang ?? "with no language"}, but the matching block in ${other(side)} (line ${blocks[opposite(side)].line}) is ${blocks[opposite(side)].lang ?? "unmarked"}.`,
      });
      return;
    }
    if (x.lines.length !== y.lines.length) {
      differences.push({
        severity: "warning",
        text: `code:${i}:lines`,
        at: blocks,
        message: (side) =>
          `This code block has ${plural(blocks[side].lines.length, "line")}, but the matching block in ${other(side)} (line ${blocks[opposite(side)].line}) has ${blocks[opposite(side)].lines.length}. Code is the same in every version; only comments and output text are translated.`,
      });
      return;
    }
    if (!lineByLine) return;
    const changed = codeLineDifferences(x, y);
    const k = changed[0];
    if (k === undefined) return;
    const lines = {
      source: { line: x.firstLine + k, column: 1 },
      translation: { line: y.firstLine + k, column: 1 },
    };
    const script = names.source;
    differences.push({
      severity: "warning",
      text: `code:${i}:${k}`,
      at: lines,
      message: (side) => {
        const here = blocks[side].lines[k] ?? "";
        const there = blocks[opposite(side)].lines[k] ?? "";
        const more =
          changed.length > 1
            ? ` ${changed.length - 1} more line(s) in this block differ the same way.`
            : "";
        return `This line of code differs from ${other(side)} (line ${lines[opposite(side)].line}): \`${clip(here)}\` vs \`${clip(there)}\`. Neither has ${describeScript(script, names.translation)} text, so it is code, not a translation: was it changed in only one version?${more}`;
      },
    });
  });
  return differences;
}

/** Indexes of lines that differ although neither version contains a non-Latin letter. */
function codeLineDifferences(x: CodeBlock, y: CodeBlock): number[] {
  return x.lines.flatMap((line, k) => {
    const theirs = y.lines[k] ?? "";
    if (line === theirs) return [];
    if (NON_LATIN_LETTER.test(line) || NON_LATIN_LETTER.test(theirs)) return [];
    return [k];
  });
}

function sameSkeleton(x: CodeBlock | undefined, y: CodeBlock | undefined, lineByLine: boolean) {
  if (!x || !y) return false;
  if (x.lang !== y.lang || x.lines.length !== y.lines.length) return false;
  return !lineByLine || codeLineDifferences(x, y).length === 0;
}

/** The first index below `length` where `matches` is false, or undefined if there is none. */
function firstIndex(length: number, matches: (i: number) => boolean): number | undefined {
  for (let i = 0; i < length; i++) if (!matches(i)) return i;
  return undefined;
}

function usesNonLatinScript(locale: string): boolean {
  try {
    return new Intl.Locale(locale).maximize().script !== "Latn";
  } catch {
    return false;
  }
}

/** "Chinese (Taiwan)" for zh-TW: the language whose script tells translated lines apart. */
function describeScript(sourceLocale: string, translationLocale: string): string {
  const locale = usesNonLatinScript(sourceLocale) ? sourceLocale : translationLocale;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

const normalize = (dir: string) => dir.replace(/^\.\/+/, "").replace(/\/+$/, "");
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const show = (value: unknown) => clip(JSON.stringify(value) ?? "nothing");
const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s).trim();
const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;
