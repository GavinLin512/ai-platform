import { serve } from "@hono/node-server";
import { anthropicClient, createAiRules, UsageMeter } from "@l10n-review/ai";
import { createDatabase, reviewStore } from "@l10n-review/db";
import { migrateDatabase } from "@l10n-review/db/migrate";
import { loadEnv } from "./env.ts";
import { createGitHubApp } from "./github/app.ts";
import { createLogger } from "./logger.ts";
import { inProcessQueue, postgresQueue } from "./queue.ts";
import { createServer } from "./server.ts";
import { createReviewWorker } from "./worker.ts";

// Composition root: the only file that knows how the pieces fit together.

const env = loadEnv();
const log = createLogger({ level: env.LOG_LEVEL, format: env.LOG_FORMAT });

const database = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : undefined;
if (database) await migrateDatabase(database);

const queue = env.DATABASE_URL ? postgresQueue(env.DATABASE_URL, log) : inProcessQueue(log);
if (queue.kind === "in-process") {
  log.warn("DATABASE_URL is not set: reviews run in-process and are lost if the process stops");
}

const app = createGitHubApp(env, { queue, log });
await queue.start(
  createReviewWorker({
    getOctokit: (installationId) => app.getInstallationOctokit(installationId),
    store: database && reviewStore(database.db),
    log,
    // The LLM checks run only with an API key; the model and effort come from .l10nrc.yml.
    createAi: env.ANTHROPIC_API_KEY
      ? () => {
          const meter = new UsageMeter();
          return {
            meter,
            extraRules: (config) =>
              createAiRules(
                config,
                anthropicClient({ model: config.ai?.model, effort: config.ai?.effort, meter }),
                meter,
              ),
          };
        }
      : undefined,
  }),
);
log.info({ llmChecks: Boolean(env.ANTHROPIC_API_KEY) }, "configuration loaded");

const server = createServer(app.webhooks, { log, ready: database?.ping ?? (async () => true) });
const http = serve({ fetch: server.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, queue: queue.kind }, "l10n-review listening");
});

// Graceful shutdown. Cloud Run and Kubernetes send SIGTERM before stopping a container:
// stop accepting requests, let running reviews finish (or hand them back to the queue),
// close the database, then exit.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS + 2000).unref();
  http.close();
  await queue.stop(env.SHUTDOWN_TIMEOUT_MS);
  await database?.close();
  clearTimeout(forceExit);
  log.info("bye");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
