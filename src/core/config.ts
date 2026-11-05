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

export const CONFIG_FILES = [".l10nrc.yml", ".l10nrc.yaml"];

const words = z.array(z.string().min(1));

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
          z.strictObject({ attributes: words.optional(), ignoreElements: words.optional() }),
        ])
        .optional(),
      "locale-keys": z.boolean().optional(),
      "locale-placeholders": z.boolean().optional(),
      "intl-format": z.boolean().optional(),
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
