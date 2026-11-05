import type { ReviewStore } from "@l10n-review/db";
import type { Octokit } from "octokit";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewPullRequest } from "../src/github/review.ts";
import { createReviewWorker } from "../src/worker.ts";

vi.mock("../src/github/review.ts", () => ({ reviewPullRequest: vi.fn() }));

const job = {
  installationId: 42,
  owner: "acme",
  repo: "shop",
  pullNumber: 7,
  headSha: "abc1234567",
  deliveryId: "d1",
};
const log = pino({ level: "silent" });

function fakeStore() {
  return {
    start: vi.fn(async () => "run-1"),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  } satisfies ReviewStore;
}

describe("createReviewWorker", () => {
  // Braces matter: a function returned from beforeEach is run as cleanup after each test,
  // and mockReset() returns the mock itself, which would then be called (and throw).
  beforeEach(() => {
    vi.mocked(reviewPullRequest).mockReset();
  });

  it("reviews with the installation's Octokit and records the run", async () => {
    const octokit = {} as Octokit;
    const getOctokit = vi.fn(async () => octokit);
    const store = fakeStore();
    vi.mocked(reviewPullRequest).mockResolvedValue({
      result: { filesChecked: 1, findings: 1, alreadyReported: 0, posted: 1 },
      findings: [
        {
          ruleId: "locale-keys",
          path: "locales/en.json",
          line: 3,
          column: 3,
          severity: "warning",
          text: "missing:cart.checkout",
          message: "…",
          fingerprint: "fp1",
          isNew: true,
        },
      ],
    });

    await createReviewWorker({ getOctokit, store, log })(job);

    expect(getOctokit).toHaveBeenCalledWith(42);
    expect(reviewPullRequest).toHaveBeenCalledWith(octokit, {
      owner: "acme",
      repo: "shop",
      pullNumber: 7,
      headSha: "abc1234567",
    });
    expect(store.start).toHaveBeenCalledWith({
      repo: "acme/shop",
      pullNumber: 7,
      headSha: "abc1234567",
      deliveryId: "d1",
    });
    expect(store.complete).toHaveBeenCalledWith(
      "run-1",
      { filesChecked: 1, findings: 1, alreadyReported: 0, posted: 1 },
      [
        {
          ruleId: "locale-keys",
          path: "locales/en.json",
          line: 3,
          severity: "warning",
          fingerprint: "fp1",
          message: "…",
          isNew: true,
        },
      ],
    );
  });

  it("records the failure and rethrows, so the queue retries", async () => {
    const store = fakeStore();
    vi.mocked(reviewPullRequest).mockImplementation(async () => {
      throw new Error("GitHub said 502");
    });

    const run = createReviewWorker({ getOctokit: async () => ({}) as Octokit, store, log })(job);

    await expect(run).rejects.toThrow("GitHub said 502");
    expect(store.fail).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("works without a database", async () => {
    vi.mocked(reviewPullRequest).mockResolvedValue({
      result: { filesChecked: 0, findings: 0, alreadyReported: 0, posted: 0 },
      findings: [],
    });
    await expect(
      createReviewWorker({ getOctokit: async () => ({}) as Octokit, log })(job),
    ).resolves.toBeUndefined();
  });
});
