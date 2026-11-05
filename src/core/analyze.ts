import picomatch from "picomatch";
import { CONFIG_FILES, type LoadedConfig, loadConfig } from "./config.ts";
import { type ChangedFile, runRules } from "./engine.ts";
import { createRules } from "./rules/index.ts";
import type { Finding, RepoReader, Rule } from "./types.ts";

// The one entry point every integration (GitHub App, CLI, Action) uses:
// load .l10nrc.yml → build the rules it asks for → run them on the change.

export interface ReviewSetup {
  config: LoadedConfig;
  rules: Rule[];
  /** Whether a changed file is worth fetching: some rule looks at it, or it is the config. */
  isRelevant(path: string): boolean;
}

export async function loadReviewSetup(reader: RepoReader): Promise<ReviewSetup> {
  const config = await loadConfig(reader);
  const rules = createRules(config.config);
  const ignored = picomatch(config.config.ignore ?? [], { dot: true });
  return {
    config,
    rules,
    isRelevant: (path) =>
      CONFIG_FILES.includes(path) || (!ignored(path) && rules.some((rule) => rule.appliesTo(path))),
  };
}

export async function analyzeChanges(
  files: ChangedFile[],
  reader: RepoReader,
  setup: ReviewSetup,
): Promise<Finding[]> {
  const relevant = files.filter((file) => setup.isRelevant(file.path));
  const findings = await runRules(relevant, { rules: setup.rules, reader });

  // A broken .l10nrc.yml is reported where it is broken, if this change touched it.
  const { path, problems } = setup.config;
  const configChange = relevant.find((file) => file.path === path);
  if (path && configChange) {
    for (const problem of problems) {
      if (configChange.addedLines && !configChange.addedLines.has(problem.line)) continue;
      findings.push({
        ruleId: "config",
        path,
        line: problem.line,
        column: problem.column,
        severity: "error",
        text: problem.message,
        message: `${problem.message} The default configuration is used until this is fixed.`,
      });
    }
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
