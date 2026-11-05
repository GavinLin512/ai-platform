import { PgBoss } from "pg-boss";
import type { Logger } from "./logger.ts";

// Why a queue: GitHub waits at most 10 seconds for a webhook response, a review can take
// longer, and a process can restart at any moment (deploys, crashes, scale-down).
// The webhook only records "review this commit" and answers 202; workers do the review.
// With Postgres the job survives restarts and is retried; without it (local development)
// it simply runs in the background of the same process.

export interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  deliveryId: string;
}

export type ReviewHandler = (job: ReviewJob) => Promise<void>;

export interface ReviewQueue {
  readonly kind: "postgres" | "in-process";
  /** False when the same commit is already queued (e.g. GitHub redelivered the webhook). */
  enqueue(job: ReviewJob): Promise<boolean>;
  /** Begin handing jobs to `handler`. */
  start(handler: ReviewHandler): Promise<void>;
  /** Stop taking new jobs and wait up to `timeoutMs` for running ones. */
  stop(timeoutMs: number): Promise<void>;
}

/** Runs jobs right away in this process. Lost if the process stops: development only. */
export function inProcessQueue(log: Logger): ReviewQueue {
  let handler: ReviewHandler | undefined;
  const running = new Set<Promise<void>>();
  return {
    kind: "in-process",
    async enqueue(job) {
      if (!handler) throw new Error("queue not started");
      const run = handler(job)
        .catch((error: unknown) => log.error({ err: error }, "review job failed"))
        .finally(() => running.delete(run));
      running.add(run);
      return true;
    },
    async start(h) {
      handler = h;
    },
    async stop(timeoutMs) {
      handler = undefined;
      await Promise.race([Promise.allSettled(running), sleep(timeoutMs)]);
    },
  };
}

const QUEUE = "review-pull-request";

/** A durable queue in Postgres (pg-boss): jobs survive restarts and are retried with backoff. */
export function postgresQueue(
  connectionString: string,
  log: Logger,
  options: { concurrency?: number; schema?: string } = {},
): ReviewQueue {
  const boss = new PgBoss({ connectionString, schema: options.schema ?? "pgboss" });
  boss.on("error", (error) => log.error({ err: error }, "pg-boss error"));
  let ready: Promise<unknown> | undefined;
  const started = () => {
    ready ??= boss.start().then(() =>
      boss.createQueue(QUEUE, {
        // "stately": per singleton key, at most one job waiting and one running. So a
        // redelivered webhook is dropped, and two workers never review the same commit at
        // the same time (they would both decide to post, and post the same comments twice).
        // The default "standard" policy does not de-duplicate at all.
        policy: "stately",
        retryLimit: 4,
        retryDelay: 30,
        retryBackoff: true, // 30s, 60s, 120s… so a GitHub outage is waited out
        expireInSeconds: 10 * 60, // a review stuck for 10 minutes is considered dead
      }),
    );
    return ready;
  };

  return {
    kind: "postgres",
    async enqueue(job) {
      await started();
      // Same commit of the same PR = same singleton key. send() returns null when the
      // queue policy rejects it as a duplicate.
      const singletonKey = `${job.owner}/${job.repo}#${job.pullNumber}@${job.headSha}`;
      return (await boss.send(QUEUE, { ...job }, { singletonKey })) !== null;
    },
    async start(handler) {
      await started();
      await boss.work<ReviewJob>(
        QUEUE,
        { localConcurrency: options.concurrency ?? 2 },
        async ([job]) => {
          if (job) await handler(job.data); // throwing marks the job failed → retried
        },
      );
    },
    async stop(timeoutMs) {
      if (!ready) return;
      await boss.stop({ graceful: true, timeout: timeoutMs });
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
