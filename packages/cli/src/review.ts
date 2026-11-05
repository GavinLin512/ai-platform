import { anthropicClient, createAiRules, type Effort, UsageMeter } from "@l10n-review/ai";
import { analyzeChanges, type ChangedFile, type Finding, loadReviewSetup } from "@l10n-review/core";
import { allFiles, type Change, changedFiles, repoRoot } from "./git.ts";
import { fsReader } from "./reader.ts";

export interface ReviewOptions {
  cwd: string;
  /** Compare against this ref; ignored with `all`. */
  base: string;
  all?: boolean;
  /** Run the LLM checks (needs ANTHROPIC_API_KEY). Off by default: they cost money. */
  ai?: boolean;
}

export interface ReviewOutcome {
  findings: Finding[];
  filesChecked: number;
  meter: UsageMeter;
}

/** The same pipeline as the GitHub App, reading the working tree instead of the GitHub API. */
export async function review(options: ReviewOptions): Promise<ReviewOutcome> {
  const root = await repoRoot(options.cwd);
  const reader = fsReader(root);
  const meter = new UsageMeter();
  const setup = await loadReviewSetup(reader, {
    extraRules: options.ai
      ? (config) =>
          createAiRules(
            config,
            anthropicClient({
              model: config.ai?.model,
              effort: config.ai?.effort as Effort | undefined,
              meter,
            }),
            meter,
          )
      : undefined,
  });

  const changes: Change[] = options.all
    ? await allFiles(root)
    : await changedFiles(options.base, root);
  const files: ChangedFile[] = [];
  for (const change of changes.filter((c) => setup.isRelevant(c.path))) {
    const content = await reader.readFile(change.path);
    if (content !== undefined)
      files.push({ path: change.path, content, addedLines: change.addedLines });
  }

  const findings = await analyzeChanges(files, reader, setup);
  return { findings, filesChecked: files.length, meter };
}

export type FailOn = "error" | "warning" | "never";

/** Exit status for CI: 1 when a finding is at least as severe as `failOn`. */
export function exitCode(findings: Finding[], failOn: FailOn): number {
  if (failOn === "never") return 0;
  const severities = failOn === "warning" ? ["error", "warning"] : ["error"];
  return findings.some((f) => severities.includes(f.severity)) ? 1 : 0;
}
