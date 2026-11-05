export { parseAddedLines } from "./diff.ts";
export { type ChangedFile, fingerprint, type RunOptions, runRules } from "./engine.ts";
export type { LocaleRuleOptions } from "./locale/set.ts";
export { cachedReader, memoryReader } from "./reader.ts";
export { defaultRules } from "./rules/index.ts";
export { createLocaleKeysRule } from "./rules/locale-keys.ts";
export { createLocalePlaceholdersRule } from "./rules/locale-placeholders.ts";
export {
  createNoHardcodedStringRule,
  isTranslatable,
  type NoHardcodedStringOptions,
} from "./rules/no-hardcoded-string.ts";
export type {
  DirEntry,
  Finding,
  RepoReader,
  Rule,
  RuleContext,
  Severity,
  SourceFile,
} from "./types.ts";
