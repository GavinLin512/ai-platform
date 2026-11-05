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

/**
 * A hand-rolled stand-in for the few Octokit methods the review uses.
 * `repo` holds files that exist at head but are not part of the PR (e.g. other locales).
 * getContent behaves like GitHub's contents API: a file, a directory listing, or a 404.
 */
function fakeOctokit(
  files: FakeFile[],
  existingComments: { body: string }[] = [],
  repo: Record<string, string> = {},
) {
  const tree: Record<string, string> = { ...repo };
  for (const file of files) if (file.content !== undefined) tree[file.filename] = file.content;

  const listFiles = vi.fn();
  const listReviewComments = vi.fn();
  const createReview = vi.fn().mockResolvedValue({ data: {} });
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path in tree) {
      const content = Buffer.from(tree[path] as string).toString("base64");
      return { data: { type: "file", encoding: "base64", content } };
    }
    const prefix = `${path}/`;
    const children = new Map<string, string>();
    for (const filePath of Object.keys(tree)) {
      if (!filePath.startsWith(prefix)) continue;
      const [name, ...rest] = filePath.slice(prefix.length).split("/");
      children.set(name as string, rest.length > 0 ? "dir" : "file");
    }
    if (children.size === 0) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: [...children].map(([name, type]) => ({ name, type })) };
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

describe("locale rules through the GitHub API", () => {
  it("reads the other locales from the repository and comments on the source", async () => {
    const en = JSON.stringify({ "cart.title": "Cart", "cart.checkout": "Checkout" }, null, 2);
    const { octokit, createReview } = fakeOctokit(
      // The PR added line 3 of en.json ("cart.checkout").
      [{ filename: "locales/en.json", patch: "@@ -1,3 +1,4 @@\n a\n b\n+c\n d", content: en }],
      [],
      {
        "locales/ja.json": JSON.stringify({ "cart.title": "カート" }, null, 2),
        "locales/zh-TW.json": JSON.stringify({ "cart.title": "購物車" }, null, 2),
      },
    );

    const result = await reviewPullRequest(octokit, pr);

    expect(result).toMatchObject({ filesChecked: 1, findings: 1, posted: 1 });
    const comment = createReview.mock.calls[0]?.[0].comments[0];
    expect(comment).toMatchObject({ path: "locales/en.json", line: 3 });
    expect(comment.body).toContain('Key "cart.checkout" is missing from ja and zh-TW.');
  });
});
