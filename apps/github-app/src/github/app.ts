import { App } from "octokit";
import type { Env } from "../env.ts";
import { reviewPullRequest } from "./review.ts";

// A GitHub App authenticates as itself (JWT signed with the private key), then exchanges
// that for a short-lived token per installation. `octokit` does all of that for us:
// the `octokit` passed to each webhook handler is already scoped to the repo's installation.

export type GitHubAppConfig = Pick<
  Env,
  "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET"
>;

export function createGitHubApp(config: GitHubAppConfig): App {
  const app = new App({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_PRIVATE_KEY,
    webhooks: { secret: config.GITHUB_WEBHOOK_SECRET },
  });

  app.webhooks.on(
    ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"],
    async ({ id, octokit, payload }) => {
      const pr = {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pullNumber: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
      };
      const result = await reviewPullRequest(octokit, pr);
      console.info(
        JSON.stringify({
          msg: "review completed",
          delivery: id,
          pr: `${pr.owner}/${pr.repo}#${pr.pullNumber}`,
          ...result,
        }),
      );
    },
  );

  app.webhooks.onError((error) => {
    console.error(JSON.stringify({ msg: "webhook handler failed", error: String(error) }));
  });

  return app;
}
