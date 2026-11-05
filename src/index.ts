import { serve } from "@hono/node-server";
import { loadEnv } from "./env.ts";
import { createGitHubApp } from "./github/app.ts";
import { createServer } from "./server.ts";

const env = loadEnv();
const app = createGitHubApp(env);
const server = createServer(app.webhooks);

serve({ fetch: server.fetch, port: env.PORT }, (info) => {
  console.info(`l10n-review listening on http://localhost:${info.port}`);
  console.info(`Webhook endpoint: POST http://localhost:${info.port}/api/github/webhooks`);
});
