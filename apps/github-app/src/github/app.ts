import { App } from "octokit";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";
import type { ReviewQueue } from "../queue.ts";

// A GitHub App authenticates as itself (JWT signed with the private key), then exchanges
// that for a short-lived token per installation. `octokit` does all of that for us.
// Webhook handlers only enqueue work: the review itself runs in a worker (src/worker.ts).

export type GitHubAppConfig = Pick<
  Env,
  "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET"
>;

export function createGitHubApp(
  config: GitHubAppConfig,
  deps: { queue: ReviewQueue; log: Logger },
): App {
  const app = new App({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_PRIVATE_KEY,
    webhooks: { secret: config.GITHUB_WEBHOOK_SECRET },
  });

  app.webhooks.on(
    ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
    async ({ id, payload }) => {
      const installationId = payload.installation?.id;
      const pr = `${payload.repository.full_name}#${payload.pull_request.number}`;
      if (!installationId) {
        deps.log.warn({ delivery: id, pr }, "pull_request event without an installation; ignored");
        return;
      }
      const queued = await deps.queue.enqueue({
        installationId,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pullNumber: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
        deliveryId: id,
      });
      deps.log.info(
        { delivery: id, pr, queue: deps.queue.kind },
        queued ? "review queued" : "review already queued for this commit; skipped",
      );
    },
  );

  return app;
}
