import type { Rule } from "../types.ts";
import { createNoHardcodedStringRule } from "./no-hardcoded-string.ts";

export const defaultRules: Rule[] = [createNoHardcodedStringRule()];
