import { type Finding, fingerprint } from "@l10n-review/core";

// Each comment carries an invisible HTML marker with the finding's fingerprint.
// On the next push we read existing comments back and skip anything already reported,
// which makes the review idempotent: re-running it never spams the PR.

const MARKER_PREFIX = "l10n-review:fp=";
const MARKER_PATTERN = /<!-- l10n-review:fp=([a-f0-9]+) -->/g;

export function formatFindingComment(finding: Finding): string {
  return [
    `**l10n-review** · \`${finding.ruleId}\``,
    "",
    finding.message,
    "",
    `<!-- ${MARKER_PREFIX}${fingerprint(finding)} -->`,
  ].join("\n");
}

export function extractFingerprints(body: string): string[] {
  return [...body.matchAll(MARKER_PATTERN)].map((match) => match[1] as string);
}

export function formatReviewSummary(newFindings: number, posted: number): string {
  const lines = [
    `**l10n-review** found ${newFindings} new localization ${newFindings === 1 ? "issue" : "issues"} in this change.`,
  ];
  if (posted < newFindings) {
    lines.push(
      "",
      `Showing the first ${posted}. Push a fix and the next review will pick up the rest.`,
    );
  }
  return lines.join("\n");
}
