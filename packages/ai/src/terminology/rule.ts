import {
  type Finding,
  parseLocaleJson,
  parseLocalePath,
  type Rule,
  sameLocale,
} from "@l10n-review/core";
import { z } from "zod";
import { chunk, tryComplete } from "../batch.ts";
import type { LlmClient, UsageMeter } from "../llm.ts";
import { TERMINOLOGY_SYSTEM, TERMINOLOGY_VERIFY_SYSTEM } from "../prompts.ts";
import { type Candidate, detectCandidate } from "./detect.ts";

// zh-tw-terminology: mainland Chinese wording in Taiwan Traditional Chinese strings.
//   1. dictionary pre-screen (free)       → candidates           (detect.ts)
//   2. the model judges each in context   → proposed problems
//   3. an optional verification pass      → only confirmed ones become comments
// Only strings on lines the PR added are sent, so cost follows the size of the change.

const TAIWAN_CHINESE = ["zh-TW", "zh-Hant", "zh-Hant-TW"];
const BATCH_SIZE = 40;

const JudgeOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      problems: z.array(z.object({ term: z.string(), suggestion: z.string(), reason: z.string() })),
    }),
  ),
});

const VerifyOutput = z.object({
  items: z.array(z.object({ id: z.string(), term: z.string(), confirmed: z.boolean() })),
});

export interface TerminologyOptions {
  verify?: boolean;
  localeDirs?: string[];
  meter?: UsageMeter;
}

export function createZhTwTerminologyRule(llm: LlmClient, options: TerminologyOptions = {}): Rule {
  const id = "zh-tw-terminology";
  return {
    id,
    description: "Taiwan Traditional Chinese strings should not use mainland Chinese wording.",
    appliesTo(path) {
      const locale = parseLocalePath(path, options.localeDirs)?.locale;
      return locale !== undefined && TAIWAN_CHINESE.some((tw) => sameLocale(tw, locale));
    },

    async check(file, context) {
      const entries = parseLocaleJson(file.path, file.content);
      if (!entries) return [];
      const added = context.changedFiles.get(file.path);

      const candidates = [...entries.values()]
        .filter((entry) => !added || added.has(entry.line))
        .flatMap((entry) => {
          const candidate = detectCandidate(entry.value);
          return candidate ? [{ entry, candidate }] : [];
        });

      const findings: Finding[] = [];
      for (const batch of chunk(candidates, BATCH_SIZE)) {
        const byId = new Map(batch.map((item, index) => [String(index), item]));

        const judged = await tryComplete(
          llm,
          {
            purpose: "terminology.judge",
            system: TERMINOLOGY_SYSTEM,
            prompt: JSON.stringify(
              batch.map(({ entry, candidate }, index) => ({
                id: String(index),
                key: entry.key,
                text: entry.value,
                hints: hints(candidate),
              })),
            ),
            schema: JudgeOutput,
          },
          options.meter,
        );
        const proposed = (judged?.items ?? []).flatMap((item) => {
          const source = byId.get(item.id);
          // Ignore terms that are not in the text: the model may not invent problems.
          return source
            ? item.problems
                .filter((p) => source.entry.value.includes(p.term) && p.term !== p.suggestion)
                .map((problem) => ({ id: item.id, ...source, problem }))
            : [];
        });
        if (proposed.length === 0) continue;

        let confirmed = proposed;
        if (options.verify ?? true) {
          const verdict = await tryComplete(
            llm,
            {
              purpose: "terminology.verify",
              system: TERMINOLOGY_VERIFY_SYSTEM,
              prompt: JSON.stringify(
                proposed.map(({ id: itemId, entry, problem }) => ({
                  id: itemId,
                  key: entry.key,
                  text: entry.value,
                  term: problem.term,
                  suggestion: problem.suggestion,
                })),
              ),
              schema: VerifyOutput,
            },
            options.meter,
          );
          const ok = new Set(
            (verdict?.items ?? []).filter((v) => v.confirmed).map((v) => `${v.id}\0${v.term}`),
          );
          confirmed = proposed.filter((p) => ok.has(`${p.id}\0${p.problem.term}`));
        }

        for (const { entry, problem } of confirmed) {
          findings.push({
            ruleId: id,
            path: file.path,
            line: entry.line,
            column: entry.column,
            severity: "warning",
            text: `${entry.key}:${problem.term}`,
            message: `「${problem.term}」在台灣通常說「${problem.suggestion}」。${problem.reason}`,
          });
        }
      }
      return findings;
    },
  };
}

function hints(candidate: Candidate) {
  return candidate.changes.map((c) => `${c.from || "∅"} → ${c.to || "∅"}`);
}
