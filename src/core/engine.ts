import { createHash } from "node:crypto";
import { defaultRules } from "./rules/index.ts";
import type { Finding, Rule, SourceFile } from "./types.ts";

export interface ChangedFile extends SourceFile {
  /**
   * Lines added by the change. When present, findings on other lines are dropped:
   * we review what the author touched, not the whole legacy file.
   */
  addedLines?: ReadonlySet<number>;
}

export function runRules(files: ChangedFile[], rules: Rule[] = defaultRules): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    for (const rule of rules) {
      if (!rule.appliesTo(file.path)) continue;

      for (const finding of rule.check(file)) {
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
