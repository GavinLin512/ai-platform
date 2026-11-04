import { createHash } from "node:crypto";
import { memoryReader } from "./reader.ts";
import { defaultRules } from "./rules/index.ts";
import type { Finding, RepoReader, Rule, RuleContext, SourceFile } from "./types.ts";

export interface ChangedFile extends SourceFile {
  /**
   * Lines added by the change. When present, findings on other lines are dropped:
   * we review what the author touched, not the whole legacy file.
   */
  addedLines?: ReadonlySet<number>;
}

export interface RunOptions {
  rules?: Rule[];
  /** Access to files outside the change. Defaults to just the changed files themselves. */
  reader?: RepoReader;
}

export async function runRules(files: ChangedFile[], options: RunOptions = {}): Promise<Finding[]> {
  const rules = options.rules ?? defaultRules;
  const context: RuleContext = {
    reader:
      options.reader ?? memoryReader(Object.fromEntries(files.map((f) => [f.path, f.content]))),
    changedFiles: new Map(files.map((f) => [f.path, f.addedLines])),
  };
  const findings: Finding[] = [];

  for (const file of files) {
    for (const rule of rules) {
      if (!rule.appliesTo(file.path)) continue;

      for (const finding of await rule.check(file, context)) {
        if (file.addedLines && !file.addedLines.has(finding.line)) continue;
        findings.push(finding);
      }
    }
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * A stable identity for a finding that does not depend on its line number,
 * so the same issue is not reported again when later commits shift the code around.
 */
export function fingerprint(finding: Finding): string {
  return createHash("sha256")
    .update(`${finding.ruleId}\0${finding.path}\0${finding.text}`)
    .digest("hex")
    .slice(0, 16);
}
