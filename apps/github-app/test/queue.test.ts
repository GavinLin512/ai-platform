import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { inProcessQueue, postgresQueue, type ReviewJob } from "../src/queue.ts";

const log = pino({ level: "silent" });
const job: ReviewJob = {
  installationId: 1,
  owner: "acme",
  repo: "shop",
  pullNumber: 7,
  headSha: "abc123",
  deliveryId: "d1",
};

describe("inProcessQueue", () => {
  it("runs jobs in the background and waits for them on stop", async () => {
    const queue = inProcessQueue(log);
    let finished = false;
    await queue.start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    });

    expect(await queue.enqueue(job)).toBe(true);
    expect(finished).toBe(false); // enqueue does not wait for the review
    await queue.stop(1000);
    expect(finished).toBe(true); // stop does
  });

  it("does not let a failing job escape", async () => {
    const queue = inProcessQueue(log);
    await queue.start(async () => {
      throw new Error("boom");
    });
    await queue.enqueue(job);
    await expect(queue.stop(1000)).resolves.toBeUndefined();
  });

  it("refuses jobs before it is started", async () => {
    await expect(inProcessQueue(log).enqueue(job)).rejects.toThrow("not started");
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("postgresQueue (Postgres)", () => {
  it("delivers an enqueued job to the worker", async () => {
    const queue = postgresQueue(url ?? "", log, { schema: `pgboss_test_${Date.now()}` });
    const handled = vi.fn(async () => {});
    await queue.start(handled);
    await queue.enqueue(job);

    await vi.waitFor(() => expect(handled).toHaveBeenCalledWith(job), { timeout: 15_000 });
    await queue.stop(5000);
  }, 30_000);

  it("drops a duplicate of a job that is still waiting", async () => {
    const queue = postgresQueue(url ?? "", log, { schema: `pgboss_test_${Date.now()}_dup` });
    // Not started as a worker: both sends find the first job still waiting.
    expect(await queue.enqueue(job)).toBe(true);
    expect(await queue.enqueue({ ...job, deliveryId: "d2" })).toBe(false);
    expect(await queue.enqueue({ ...job, headSha: "def456" })).toBe(true); // another commit
    await queue.stop(5000);
  }, 30_000);
});
