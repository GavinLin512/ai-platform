import {
  type Finding,
  loadLocaleSet,
  lookup,
  parseLocalePath,
  type Rule,
  sameLocale,
} from "@l10n-review/core";
import { z } from "zod";
import { chunk, tryComplete } from "../batch.ts";
import type { LlmClient, UsageMeter } from "../llm.ts";
import { MEANING_SYSTEM, MEANING_VERIFY_SYSTEM } from "../prompts.ts";
import { findExamples } from "./retrieve.ts";

// translation-meaning: a translation that says something else than its source, or whose tone
// clashes with the rest of the product. Same shape as the terminology check: only lines the PR
// added, batched, an optional verification pass, and failures never fail the review.

const BATCH_SIZE = 25;
const KINDS = new Set(["meaning", "tone"]);

const JudgeOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      issues: z.array(
        z.object({ kind: z.string(), explanation: z.string(), suggestion: z.string() }),
      ),
    }),
  ),
});

const VerifyOutput = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string(), confirmed: z.boolean() })),
});

export interface MeaningOptions {
  verify?: boolean;
  sourceLocale?: string;
  localeDirs?: string[];
  meter?: UsageMeter;
}

export function createTranslationMeaningRule(llm: LlmClient, options: MeaningOptions = {}): Rule {
  const id = "translation-meaning";
  const sourceLocale = options.sourceLocale ?? "en";
  return {
    id,
    description: "Translations should mean what their source says, in the product's tone.",
    appliesTo(path) {
      const locale = parseLocalePath(path, options.localeDirs)?.locale;
      return locale !== undefined && !sameLocale(locale, sourceLocale);
    },

    async check(file, context) {
      const set = await loadLocaleSet(file, context.reader, {
        sourceLocale,
        localeDirs: options.localeDirs,
      });
      if (!set?.source || set.self === set.source) return [];
      const { self, source } = set;
      const added = context.changedFiles.get(file.path);

      const items = [...self.entries.values()]
        .filter((entry) => (!added || added.has(entry.line)) && entry.value.trim() !== "")
        .flatMap((entry) => {
          const original = lookup(source.entries, entry.key);
          return original ? [{ entry, original }] : [];
        });

      const findings: Finding[] = [];
      for (const batch of chunk(items, BATCH_SIZE)) {
        const payload = batch.map(({ entry, original }, index) => ({
          id: String(index),
          key: entry.key,
          sourceLocale: source.file.locale,
          source: original.value,
          targetLocale: self.file.locale,
          translation: entry.value,
          styleExamples: findExamples(self, source, entry.key, original.value),
        }));

        const judged = await tryComplete(
          llm,
          {
            purpose: "meaning.judge",
            system: MEANING_SYSTEM,
            prompt: JSON.stringify(payload),
            schema: JudgeOutput,
          },
          options.meter,
        );
        const proposed = (judged?.items ?? []).flatMap((item) => {
          const target = batch[Number(item.id)];
          return target
            ? item.issues
                .filter((issue) => KINDS.has(issue.kind))
                .map((issue) => ({ id: item.id, ...target, issue }))
            : [];
        });
        if (proposed.length === 0) continue;

        let confirmed = proposed;
        if (options.verify ?? true) {
          const verdict = await tryComplete(
            llm,
            {
              purpose: "meaning.verify",
              system: MEANING_VERIFY_SYSTEM,
              prompt: JSON.stringify(
                proposed.map((p) => ({
                  ...payload[Number(p.id)],
                  kind: p.issue.kind,
                  explanation: p.issue.explanation,
                  suggestion: p.issue.suggestion,
                })),
              ),
              schema: VerifyOutput,
            },
            options.meter,
          );
          const ok = new Set(
            (verdict?.items ?? []).filter((v) => v.confirmed).map((v) => `${v.id}\0${v.kind}`),
          );
          confirmed = proposed.filter((p) => ok.has(`${p.id}\0${p.issue.kind}`));
        }

        for (const { entry, original, issue } of confirmed) {
          findings.push({
            ruleId: id,
            path: file.path,
            line: entry.line,
            column: entry.column,
            severity: "warning",
            text: `${entry.key}:${issue.kind}`,
            message: `${issue.kind === "tone" ? "Tone" : "Meaning"}: ${issue.explanation} Suggested: "${issue.suggestion}" (source: "${original.value}")`,
          });
        }
      }
      return findings;
    },
  };
}
