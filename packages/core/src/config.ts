import { isMap, isScalar, LineCounter, type Node, parseDocument } from "yaml";
import { z } from "zod";
import type { RepoReader } from "./types.ts";

// .l10nrc.yml at the repository root, e.g.
//
//   sourceLocale: zh-TW            # the locale translators translate from (default: en)
//   localeDirs: [locales, lang]    # directories that contain locale files
//   ignore: ["legacy/**"]          # paths no rule should look at
//   rules:
//     locale-keys: false           # turn a rule off
//     no-hardcoded-string:         # or configure it
//       attributes: [alt, title, placeholder, aria-label, tooltip]
//     content-parity:              # language versions of Markdown documents
//       pairs:
//         - source: content/blog
//           translations: { en: content/en/blog }
//   ai:                            # LLM checks; they only run when an API key is configured
//     effort: medium
//     verify: true

export const CONFIG_FILES = [".l10nrc.yml", ".l10nrc.yaml"];

const words = z.array(z.string().min(1));
const isRegExp = (source: string) => {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
};

// Strict objects reject unknown keys, so a typo like "no-hardcoded-strng" is an error
// instead of a setting that silently does nothing.
const ConfigSchema = z.strictObject({
  sourceLocale: z.string().min(1).optional(),
  localeDirs: words.optional(),
  ignore: words.optional(),
  rules: z
    .strictObject({
      "no-hardcoded-string": z
        .union([
          z.boolean(),
          z.strictObject({
            attributes: words.optional(),
            ignoreElements: words.optional(),
            ignoreText: words.optional(),
            ignorePattern: z
              .string()
              .refine(isRegExp, "must be a valid regular expression")
              .optional(),
          }),
        ])
        .optional(),
      "locale-keys": z.boolean().optional(),
      "locale-placeholders": z.boolean().optional(),
      "intl-format": z.boolean().optional(),
      // Off until it is told where the language versions of each document live. An object
      // only (no `false`), so a typo inside it is reported as an unknown setting.
      "content-parity": z
        .strictObject({
          pairs: z
            .array(
              z.strictObject({
                source: z.string().min(1),
                translations: z.record(z.string().min(1), z.string().min(1)),
              }),
            )
            .min(1),
          translatableFields: words.optional(),
        })
        .optional(),
      // Implemented in @l10n-review/ai; listed here so the whole file is validated in one place.
      "zh-tw-terminology": z.boolean().optional(),
      "translation-meaning": z.boolean().optional(),
    })
    .optional(),
  ai: z
    .strictObject({
      model: z.string().min(1).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      /** A second pass that re-checks each finding before it is posted. */
      verify: z.boolean().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RuleId = keyof NonNullable<Config["rules"]>;

export interface ConfigProblem {
  line: number;
  column: number;
  message: string;
}

export interface LoadedConfig {
  config: Config;
  /** Which file it came from; undefined when the repository has none. */
  path?: string;
  /** When non-empty, `config` is the default configuration. */
  problems: ConfigProblem[];
}

export async function loadConfig(reader: RepoReader): Promise<LoadedConfig> {
  for (const path of CONFIG_FILES) {
    const text = await reader.readFile(path);
    if (text !== undefined) return parseConfig(path, text);
  }
  return { config: {}, problems: [] };
}

export function parseConfig(path: string, text: string): LoadedConfig {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  const at = (offset: number | undefined) => {
    const { line, col } = lineCounter.linePos(offset ?? 0);
    return { line, column: col };
  };

  if (document.errors.length > 0) {
    return {
      config: {},
      path,
      problems: document.errors.map((error) => ({
        ...at(error.pos[0]),
        message: `Invalid YAML: ${error.message.split("\n")[0]}`,
      })),
    };
  }

  const result = ConfigSchema.safeParse(document.toJS() ?? {});
  if (result.success) return { config: result.data, path, problems: [] };

  return {
    config: {},
    path,
    problems: result.error.issues.flatMap((issue) => {
      // An unknown key has no value to point at: point at the key itself, once per key.
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          ...at(keyOffset(document.contents, issue.path, key)),
          message: `Unknown setting "${[...issue.path, key].join(".")}".`,
        }));
      }
      const node = document.getIn(issue.path as (string | number)[], true) as Node | undefined;
      const where = issue.path.length > 0 ? `"${issue.path.join(".")}"` : "The configuration";
      return [{ ...at(node?.range?.[0]), message: `${where}: ${issue.message}` }];
    }),
  };
}

/** Where `key` is written inside the map at `path`, for error messages. */
function keyOffset(root: unknown, path: PropertyKey[], key: string): number | undefined {
  let node = root;
  for (const segment of path) {
    if (!isMap(node)) return undefined;
    node = node.get(segment as string, true);
  }
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key);
  return isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
}
