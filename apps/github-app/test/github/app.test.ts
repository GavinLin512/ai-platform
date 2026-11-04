import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createGitHubApp } from "../../src/github/app.ts";
import type { ReviewQueue } from "../../src/queue.ts";

function setup() {
  const queue: ReviewQueue = {
    kind: "in-process",
    enqueue: vi.fn(async () => true),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const app = createGitHubApp(
    { GITHUB_APP_ID: 1, GITHUB_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "s" },
    { queue, log: pino({ level: "silent" }) },
  );
  return { app, queue };
}

const payload = (action: string, installation?: { id: number }) => ({
  action,
  installation,
  repository: { name: "shop", full_name: "acme/shop", owner: { login: "acme" } },
  pull_request: { number: 7, head: { sha: "abc123" } },
});

describe("createGitHubApp", () => {
  it.each(["opened", "reopened", "synchronize"])(
    "queues a review on pull_request.%s",
    async (action) => {
      const { app, queue } = setup();
      await app.webhooks.receive({
        id: "d1",
        name: "pull_request",
        payload: payload(action, { id: 42 }),
      } as never);

      expect(queue.enqueue).toHaveBeenCalledWith({
        installationId: 42,
        owner: "acme",
        repo: "shop",
        pullNumber: 7,
        headSha: "abc123",
        deliveryId: "d1",
      });
    },
  );

  it("ignores other pull_request actions and events without an installation", async () => {
    const { app, queue } = setup();
    await app.webhooks.receive({
      id: "d2",
      name: "pull_request",
      payload: payload("closed", { id: 42 }),
    } as never);
    await app.webhooks.receive({
      id: "d3",
      name: "pull_request",
      payload: payload("opened"),
    } as never);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
