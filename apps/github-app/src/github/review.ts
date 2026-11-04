import {
  analyzeChanges,
  type ChangedFile,
  type Finding,
  fingerprint,
  loadReviewSetup,
  parseAddedLines,
} from "@l10n-review/core";
import type { Octokit } from "octokit";
import { extractFingerprints, formatFindingComment, formatReviewSummary } from "./format.ts";
import { githubReader } from "./reader.ts";

export interface PullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The commit we review. Comments are pinned to it so they stay on the right lines. */
  headSha: string;
}

export interface ReviewResult {
  filesChecked: number;
  findings: number;
  alreadyReported: number;
  posted: number;
}

/**
 * Exactly what we send to `pulls.createReview`.
 * A `type` rather than an `interface`: Octokit's parameter type has an index signature,
 * and only type aliases are implicitly assignable to one.
 */
export type ReviewPayload = {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
};

export interface PlannedFinding extends Finding {
  fingerprint: string;
  /** False when an earlier run already commented on it. */
  isNew: boolean;
}

export interface ReviewPlan {
  result: ReviewResult;
  /** Every finding of this run, new or not: what the database records. */
  findings: PlannedFinding[];
  /** Undefined when there is nothing new to say. */
  review?: ReviewPayload;
}

/** Keep one review readable; the rest are picked up on the next push. */
const MAX_COMMENTS_PER_REVIEW = 30;
/** Parallel GitHub requests. Bursts of concurrent calls trigger GitHub's secondary rate limits. */
const FETCH_CONCURRENCY = 4;

/** Reads the PR and decides what to post, without writing anything to GitHub. */
export async function planReview(octokit: Octokit, pr: PullRequestRef): Promise<ReviewPlan> {
  const { owner, repo, pullNumber, headSha } = pr;

  // 1. Which files changed, and which lines were added?
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  // 2. Read .l10nrc.yml at the PR's head and build the rules it asks for. The same reader
  //    fetches changed files and lets rules look at files outside the change (other locales).
  const reader = githubReader(octokit, { owner, repo, ref: headSha });
  const setup = await loadReviewSetup(reader);

  const candidates = files.filter(
    (file) =>
      file.status !== "removed" &&
      // GitHub omits `patch` for binary files and very large diffs.
      file.patch !== undefined &&
      setup.isRelevant(file.filename),
  );

  // 3. Fetch the full new version of each file: the AST needs the whole file, not just the diff.
  const changed = await mapWithConcurrency(candidates, FETCH_CONCURRENCY, async (file) => {
    const content = await reader.readFile(file.filename);
    if (content === undefined) return undefined;
    return {
      path: file.filename,
      content,
      addedLines: parseAddedLines(file.patch ?? ""),
    } satisfies ChangedFile;
  });
  const sources = changed.filter((file) => file !== undefined);

  // 4. Run the rules. No GitHub-specific code: the CLI and the Action reuse the same function.
  const findings = await analyzeChanges(sources, reader, setup);
  const result: ReviewResult = {
    filesChecked: sources.length,
    findings: findings.length,
    alreadyReported: 0,
    posted: 0,
  };
  if (findings.length === 0) return { result, findings: [] };

  // 5. Drop findings we already commented on in an earlier push.
  const existingComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const reported = new Set(
    existingComments.flatMap((comment) => extractFingerprints(comment.body)),
  );
  const planned = findings.map((finding) => {
    const id = fingerprint(finding);
    return { ...finding, fingerprint: id, isNew: !reported.has(id) };
  });
  const fresh = planned.filter((finding) => finding.isNew);
  result.alreadyReported = findings.length - fresh.length;
  if (fresh.length === 0) return { result, findings: planned };

  // 6. Bundle everything into one review, so the author gets a single notification.
  const toPost = fresh.slice(0, MAX_COMMENTS_PER_REVIEW);
  const review: ReviewPayload = {
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: headSha,
    event: "COMMENT",
    body: formatReviewSummary(fresh.length, toPost.length),
    comments: toPost.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding),
    })),
  };
  return { result, findings: planned, review };
}

/** Plans the review and posts it. This is what the webhook handler calls. */
export async function reviewPullRequest(
  octokit: Octokit,
  pr: PullRequestRef,
): Promise<Omit<ReviewPlan, "review">> {
  const { result, findings, review } = await planReview(octokit, pr);
  if (review) {
    await octokit.rest.pulls.createReview(review);
    result.posted = review.comments.length;
  }
  return { result, findings };
}

/** Like Promise.all(items.map(fn)), but with at most `limit` promises in flight. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
