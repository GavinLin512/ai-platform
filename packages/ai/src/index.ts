import type { Config, Rule } from "@l10n-review/core";
import type { LlmClient, UsageMeter } from "./llm.ts";
import { createTranslationMeaningRule } from "./meaning/rule.ts";
import { createZhTwTerminologyRule } from "./terminology/rule.ts";

export {
  anthropicClient,
  type Effort,
  fakeLlmClient,
  type LlmClient,
  LlmRefusalError,
  type StructuredRequest,
  UsageMeter,
  type UsageRecord,
} from "./llm.ts";
export { findExamples, similarity } from "./meaning/retrieve.ts";
export { createTranslationMeaningRule } from "./meaning/rule.ts";
export { costUsd, PRICES, type TokenUsage } from "./pricing.ts";
export { detectCandidate, SUPPLEMENT } from "./terminology/detect.ts";
export { createZhTwTerminologyRule } from "./terminology/rule.ts";

/** The LLM checks, configured from .l10nrc.yml (rules.* toggles and the ai section). */
export function createAiRules(config: Config, llm: LlmClient, meter?: UsageMeter): Rule[] {
  const settings = config.rules ?? {};
  const verify = config.ai?.verify ?? true;
  const rules: Rule[] = [];
  if (settings["zh-tw-terminology"] !== false) {
    rules.push(createZhTwTerminologyRule(llm, { verify, localeDirs: config.localeDirs, meter }));
  }
  if (settings["translation-meaning"] !== false) {
    rules.push(
      createTranslationMeaningRule(llm, {
        verify,
        sourceLocale: config.sourceLocale,
        localeDirs: config.localeDirs,
        meter,
      }),
    );
  }
  return rules;
}
