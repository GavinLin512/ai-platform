import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";
import { extractFingerprints } from "../../src/github/format.ts";
import { planReview, reviewPullRequest } from "../../src/github/review.ts";

const pr = { owner: "acme", repo: "shop", pullNumber: 7, headSha: "abc123" };

const cartTsx = `export const Cart = () => (
  <div>
    <h1>Shopping cart</h1>
    <button>Checkout</button>
  </div>
);`;

interface FakeFile {
  filename: string;
  status?: string;
  patch?: string;
  content?: string;
}

/** A hand-rolled stand-in for the few Octokit methods the review uses. */
function fakeOctokit(files: FakeFile[], existingComments: { body: string }[] = []) {
  const listFiles = vi.fn();
  const listReviewComments = vi.fn();
  const createReview = vi.fn().mockResolvedValue({ data: {} });
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    const file = files.find((f) => f.filename === path);
    return {
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(file?.content ?? "").toString("base64"),
      },
    };
  });
  const paginate = vi.fn(async (method: unknown) => {
    if (method === listFiles) return files.map((f) => ({ status: "modified", ...f }));
    if (method === listReviewComments) return existingComments;
    throw new Error("unexpected paginate call");
  });

  const octokit = {
    paginate,
    rest: { pulls: { listFiles, listReviewComments, createReview }, repos: { getContent } },
  } as unknown as Octokit;

  return { octokit, createReview, getContent };
}

describe("reviewPullRequest", () => {
  it("comments only on hardcoded strings in added lines", async () => {
    const { octokit, createReview } = fakeOctokit([
      // Line 4 (<button>Checkout</button>) is new; line 3 already existed.
      {
        filename: "src/Cart.tsx",
        patch: "@@ -1,5 +1,6 @@\n a\n b\n c\n+d\n e\n f",
        content: cartTsx,
      },
    ]);

    const result = await reviewPullRequest(octokit, pr);

    expect(result).toEqual({ filesChecked: 1, findings: 1, alreadyReported: 0, posted: 1 });
    expect(createReview).toHaveBeenCalledOnce();
    const review = createReview.mock.calls[0]?.[0];
    expect(review).toMatchObject({
      owner: "acme",
      repo: "shop",
      pull_number: 7,
      commit_id: "abc123",
      event: "COMMENT",
      comments: [{ path: "src/Cart.tsx", line: 4, side: "RIGHT" }],
    });
    expect(review.comments[0].body).toContain('"Checkout"');
    expect(extractFingerprints(review.comments[0].body)).toHaveLength(1);
  });

  it("does not repeat findings that were reported on an earlier push", async () => {
    const first = fakeOctokit([
      {
        filename: "src/Cart.tsx",
        patch: "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f",
        content: cartTsx,
      },
    ]);
    await reviewPullRequest(first.octokit, pr);
    const previousComments = first.createReview.mock.calls[0]?.[0].comments;

    const second = fakeOctokit(
      [
        {
          filename: "src/Cart.tsx",
          patch: "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f",
          content: cartTsx,
        },
      ],
      previousComments,
    );
    const result = await reviewPullRequest(second.octokit, pr);

    expect(result).toMatchObject({ findings: 2, alreadyReported: 2, posted: 0 });
    expect(second.createReview).not.toHaveBeenCalled();
  });

  it("skips removed files, files without a patch, and files no rule cares about", async () => {
    const { octokit, getContent, createReview } = fakeOctokit([
      { filename: "src/Old.tsx", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
      { filename: "src/Huge.tsx" },
      { filename: "README.md", patch: "@@ -0,0 +1 @@\n+Hello" },
    ]);

    const result = await reviewPullRequest(octokit, pr);

    expect(result.filesChecked).toBe(0);
    expect(getContent).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
  });

  it("caps the number of comments in one review", async () => {
    const buttons = Array.from({ length: 40 }, (_, i) => `    <button>Action ${i}</button>`);
    const content = `export const A = () => (\n  <div>\n${buttons.join("\n")}\n  </div>\n);`;
    const patch = `@@ -0,0 +1,${buttons.length + 4} @@\n${content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}`;
    const { octokit, createReview } = fakeOctokit([{ filename: "src/A.tsx", patch, content }]);

    const result = await reviewPullRequest(octokit, pr);

    expect(result).toMatchObject({ findings: 40, posted: 30 });
    const review = createReview.mock.calls[0]?.[0];
    expect(review.comments).toHaveLength(30);
    expect(review.body).toContain("40 new localization issues");
    expect(review.body).toContain("Showing the first 30");
  });
});

describe("planReview", () => {
  it("returns the review it would post without writing to GitHub", async () => {
    const { octokit, createReview } = fakeOctokit([
      {
        filename: "src/Cart.tsx",
        patch: "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f",
        content: cartTsx,
      },
    ]);

    const { result, review } = await planReview(octokit, pr);

    expect(createReview).not.toHaveBeenCalled();
    expect(result).toMatchObject({ findings: 2, posted: 0 });
    expect(review?.comments.map((c) => c.line)).toEqual([3, 4]);
  });
});
