import type { Rule } from "../types.ts";
import { createLocaleKeysRule } from "./locale-keys.ts";
import { createLocalePlaceholdersRule } from "./locale-placeholders.ts";
import { createNoHardcodedStringRule } from "./no-hardcoded-string.ts";

export const defaultRules: Rule[] = [
  createNoHardcodedStringRule(),
  createLocaleKeysRule(),
  createLocalePlaceholdersRule(),
];
