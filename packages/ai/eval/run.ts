// The eval runner.
//
//   pnpm --filter @l10n-review/ai eval                         # terminology, rules only (free)
//   pnpm --filter @l10n-review/ai eval --mode llm              # needs ANTHROPIC_API_KEY
//   pnpm --filter @l10n-review/ai eval --mode llm --no-verify  # measure what the verifier buys
//   pnpm --filter @l10n-review/ai eval --suite meaning --mode llm
//
// Writes eval/results/<suite>-<mode>-<time>.json; summarize with
//   uv run eval/report.py eval/results/*.json      (or python3 eval/report.py …)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { memoryReader, runRules } from "@l10n-review/core";
import {
  anthropicClient,
  createTranslationMeaningRule,
  createZhTwTerminologyRule,
  detectCandidate,
  type Effort,
  UsageMeter,
} from "../src/index.ts";
import { confusion, metrics, type Outcome, outcome, termsFound } from "./score.ts";

const { values: args } = parseArgs({
  options: {
    suite: { type: "string", default: "terminology" },
    mode: { type: "string", default: "rules" },
    "no-verify": { type: "boolean", default: false },
    model: { type: "string", default: "claude-opus-5-5" },
    effort: { type: "string", default: "medium" },
  },
});
const verify = !args["no-verify"];

const here = new URL(".", import.meta.url);
const readCases = <T>(name: string): T[] =>
  readFileSync(new URL(`cases/${name}.jsonl`, here), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

if (args.mode === "llm" && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "--mode llm calls the Claude API: set ANTHROPIC_API_KEY (e.g. in packages/ai/.env).",
  );
  process.exit(1);
}
const meter = new UsageMeter();
const llm = () => anthropicClient({ model: args.model, effort: args.effort as Effort, meter });

interface CaseResult {
  id: string;
  input: string;
  expected: string[];
  predicted: string[];
  outcome: Outcome;
}

async function terminology(): Promise<CaseResult[]> {
  const cases = readCases<{ id: string; key: string; text: string; expected: string[] }>(
    "terminology",
  );
  let predictions: Map<string, string[]>;

  if (args.mode === "rules") {
    predictions = new Map(
      cases.map((c) => [c.id, (detectCandidate(c.text)?.changes ?? []).map((ch) => ch.from)]),
    );
  } else {
    // One zh-TW.json holding every case, reviewed like a real file (batched calls).
    const path = "locales/zh-TW.json";
    const content = JSON.stringify(Object.fromEntries(cases.map((c) => [c.key, c.text])), null, 2);
    const rule = createZhTwTerminologyRule(llm(), { verify, meter });
    const findings = await runRules([{ path, content }], {
      rules: [rule],
      reader: memoryReader({ [path]: content }),
    });
    predictions = new Map(cases.map((c) => [c.id, [] as string[]]));
    for (const finding of findings) {
      const [key, term] = finding.text.split(":");
      const match = cases.find((c) => c.key === key);
      if (match && term) predictions.get(match.id)?.push(term);
    }
  }

  return cases.map((c) => {
    const predicted = predictions.get(c.id) ?? [];
    return {
      id: c.id,
      input: c.text,
      expected: c.expected,
      predicted,
      outcome: outcome(c.expected.length > 0, predicted.length > 0),
    };
  });
}

async function meaning(): Promise<CaseResult[]> {
  if (args.mode !== "llm") {
    console.error("The meaning suite has no rules-only baseline: run it with --mode llm.");
    process.exit(1);
  }
  const cases = readCases<{
    id: string;
    targetLocale: string;
    source: string;
    translation: string;
    expected: string | null;
    examples: [string, string][];
  }>("meaning");

  const results: CaseResult[] = [];
  for (const c of cases) {
    const source = Object.fromEntries([
      ...c.examples.map(([s], i) => [`example.${i}`, s]),
      ["case.string", c.source],
    ]);
    const target = Object.fromEntries([
      ...c.examples.map(([, t], i) => [`example.${i}`, t]),
      ["case.string", c.translation],
    ]);
    const targetPath = `locales/${c.targetLocale}.json`;
    const targetJson = JSON.stringify(target, null, 2);
    const line = targetJson.split("\n").findIndex((l) => l.includes('"case.string"')) + 1;
    const repo = { "locales/en.json": JSON.stringify(source, null, 2), [targetPath]: targetJson };

    const rule = createTranslationMeaningRule(llm(), { verify, meter });
    const findings = await runRules(
      [{ path: targetPath, content: targetJson, addedLines: new Set([line]) }],
      { rules: [rule], reader: memoryReader(repo) },
    );
    const predicted = findings.map((f) => f.text.split(":")[1] ?? "");
    const expected = c.expected ? [c.expected] : [];
    results.push({
      id: c.id,
      input: `${c.source} → ${c.translation}`,
      expected,
      predicted,
      outcome: outcome(expected.length > 0, predicted.length > 0),
    });
  }
  return results;
}

const results = args.suite === "meaning" ? await meaning() : await terminology();
const summary = metrics(confusion(results.map((r) => r.outcome)));
const positives = results.filter((r) => r.expected.length > 0);
const expectedTerms = positives.reduce((n, r) => n + r.expected.length, 0);
const foundTerms = positives.reduce((n, r) => n + termsFound(r.expected, r.predicted), 0);

const report = {
  suite: args.suite,
  mode: args.mode,
  ...(args.mode === "llm" ? { model: args.model, effort: args.effort, verify } : {}),
  createdAt: new Date().toISOString(),
  metrics: summary,
  termRecall: expectedTerms === 0 ? null : foundTerms / expectedTerms,
  usage: { calls: meter.records.length, costUsd: meter.totalCostUsd, failures: meter.failures },
  cases: results,
};

const outDir = new URL("results/", here);
mkdirSync(outDir, { recursive: true });
const file = new URL(
  `${args.suite}-${args.mode}${args.mode === "llm" && !verify ? "-noverify" : ""}-${Date.now()}.json`,
  outDir,
);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(
  `${args.suite} / ${args.mode}${args.mode === "llm" ? ` (${args.model}, effort ${args.effort}, verify ${verify})` : ""}`,
);
console.log(
  `precision ${pct(summary.precision)} · recall ${pct(summary.recall)} · F1 ${pct(summary.f1)}`,
);
console.log(
  `TP ${summary.truePositives} · FP ${summary.falsePositives} · FN ${summary.falseNegatives} · TN ${summary.trueNegatives}`,
);
if (report.termRecall !== null) console.log(`term recall ${pct(report.termRecall)}`);
if (args.mode === "llm")
  console.log(`${meter.records.length} calls · $${meter.totalCostUsd.toFixed(4)}`);
for (const r of results.filter((x) => x.outcome === "FP" || x.outcome === "FN")) {
  console.log(
    `  ${r.outcome} ${r.id} ${r.input}  expected [${r.expected.join(", ")}] got [${r.predicted.join(", ")}]`,
  );
}
console.log(`→ ${file.pathname}`);
