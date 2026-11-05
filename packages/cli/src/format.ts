import type { Finding } from "@l10n-review/core";

// Three output formats: text for people, JSON for tools, and GitHub's workflow commands,
// which GitHub Actions turns into annotations on the pull request's diff.

/** "1 file", "2 files". English only: this output is read by developers, not end users. */
export const count = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

export function formatText(findings: Finding[], filesChecked: number): string {
  const lines = findings.map(
    (f) => `${f.path}:${f.line}:${f.column}  ${f.severity}  ${f.ruleId}\n    ${f.message}`,
  );
  const errors = findings.filter((f) => f.severity === "error").length;
  const summary =
    findings.length === 0
      ? `No localization issues in ${count(filesChecked, "file")}.`
      : `${count(findings.length, "issue")} (${count(errors, "error")}) in ${count(filesChecked, "file")} checked.`;
  return [...lines, summary].join("\n");
}

export function formatJson(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2);
}

/** Workflow-command escaping: messages escape %, CR and LF; properties also : and ,. */
const escapeData = (s: string) =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (s: string) => escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");

export function formatGithub(findings: Finding[]): string {
  return findings
    .map((f) => {
      const level = f.severity === "error" ? "error" : f.severity === "info" ? "notice" : "warning";
      const props = `file=${escapeProperty(f.path)},line=${f.line},col=${f.column},title=${escapeProperty(`l10n-review: ${f.ruleId}`)}`;
      return `::${level} ${props}::${escapeData(f.message)}`;
    })
    .join("\n");
}

/** A Markdown table for the Actions job summary page. */
/** GitHub shows at most this many annotations of each severity per step and drops the rest. */
export const ANNOTATIONS_PER_SEVERITY = 10;

/** A Markdown table for the Actions job summary page: every finding, even past the annotation limit. */
export function formatSummary(findings: Finding[], filesChecked: number): string {
  if (findings.length === 0) {
    return `### l10n-review\n\nNo localization issues in ${count(filesChecked, "file")}.\n`;
  }
  const truncated = ["error", "warning", "info"].some(
    (severity) => findings.filter((f) => f.severity === severity).length > ANNOTATIONS_PER_SEVERITY,
  );
  const note = truncated
    ? `\n> GitHub shows at most ${ANNOTATIONS_PER_SEVERITY} annotations of each severity on the diff. All ${findings.length} are listed here.\n`
    : "";
  const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
  const rows = findings.map(
    (f) => `| \`${cell(f.path)}:${f.line}\` | \`${f.ruleId}\` | ${cell(f.message)} |`,
  );
  return `### l10n-review\n\n${count(findings.length, "issue")} in ${count(filesChecked, "file")}.\n${note}\n| Where | Rule | Message |\n|---|---|---|\n${rows.join("\n")}\n`;
}
