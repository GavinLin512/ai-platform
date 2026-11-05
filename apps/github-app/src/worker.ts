import type { ReviewStore } from "@l10n-review/db";
import type { Octokit } from "octokit";
import { reviewPullRequest } from "./github/review.ts";
import type { Logger } from "./logger.ts";
import type { ReviewHandler } from "./queue.ts";

export interface WorkerDeps {
  /** An Octokit authenticated as the App's installation on the job's repository. */
  getOctokit(installationId: number): Promise<Octokit>;
  /** Records each run for the dashboard. Optional: without a database nothing is recorded. */
  store?: ReviewStore;
  log: Logger;
}

export function createReviewWorker(deps: WorkerDeps): ReviewHandler {
  return async (job) => {
    const pr = {
      owner: job.owner,
      repo: job.repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
    };
    const log = deps.log.child({
      delivery: job.deliveryId,
      pr: `${job.owner}/${job.repo}#${job.pullNumber}`,
      sha: job.headSha.slice(0, 7),
    });
    const runId = await deps.store?.start({
      repo: `${job.owner}/${job.repo}`,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      deliveryId: job.deliveryId,
    });

    try {
      const octokit = await deps.getOctokit(job.installationId);
      const { result, findings } = await reviewPullRequest(octokit, pr);
      if (runId) {
        await deps.store?.complete(
          runId,
          result,
          findings.map(({ ruleId, path, line, severity, fingerprint, message, isNew }) => ({
            ruleId,
            path,
            line,
            severity,
            fingerprint,
            message,
            isNew,
          })),
        );
      }
      log.info(result, "review completed");
    } catch (error) {
      if (runId) await deps.store?.fail(runId, error);
      log.error({ err: error }, "review failed");
      throw error; // let the queue retry it
    }
  };
}
