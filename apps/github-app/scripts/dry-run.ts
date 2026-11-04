// Runs the real review flow against a real pull request — real diff, real file contents,
// real de-duplication against existing comments — but prints the review instead of posting it.
// Handy for trying rules on any PR without setting up the GitHub App.
//
//   pnpm review:dry-run https://github.com/OWNER/REPO/pull/123
//   pnpm review:dry-run OWNER/REPO#123
//
// Reads GITHUB_TOKEN (from the environment or .env) if set: any token that can read the repo.
// Public repositories work without one, within GitHub's anonymous rate limit.

import { Octokit } from "octokit";
import { planReview } from "../src/github/review.ts";

const PR_PATTERN =
  /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/pull\/|#)(\d+)(?:[/?#].*)?$/;

const match = PR_PATTERN.exec(process.argv[2] ?? "");
if (!match) {
  console.error("Usage: pnpm review:dry-run <https://github.com/OWNER/REPO/pull/N | OWNER/REPO#N>");
  process.exit(1);
}
const [, owner = "", repo = "", number = ""] = match;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: Number(number) });
const { result, review } = await planReview(octokit, {
  owner,
  repo,
  pullNumber: pr.number,
  headSha: pr.head.sha,
});

const indent = (text: string) => text.replace(/^/gm, "    ");

console.log(`Dry run: ${owner}/${repo}#${pr.number} "${pr.title}" @ ${pr.head.sha.slice(0, 7)}`);
console.log("Nothing will be posted.\n");
console.log(
  `Files checked: ${result.filesChecked} · Findings: ${result.findings} · Already reported: ${result.alreadyReported}`,
);

if (!review) {
  console.log("\nNo new findings: the bot would stay silent.");
} else {
  console.log(`\nThe bot would post one review with ${review.comments.length} comment(s).\n`);
  console.log(`Review body:\n${indent(review.body)}\n`);
  for (const comment of review.comments) {
    console.log(`${comment.path}:${comment.line}\n${indent(comment.body)}\n`);
  }
}
