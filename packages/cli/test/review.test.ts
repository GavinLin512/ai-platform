import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@l10n-review/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFiles } from "../src/git.ts";
import { exitCode, review } from "../src/review.ts";

// A real git repository in a temp directory: base commit on main, then a branch with a
// committed change, an uncommitted edit and an untracked file.
let repo = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd: repo,
    stdio: "pipe",
  }).toString();
const write = (path: string, content: string) => writeFileSync(join(repo, path), content);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "l10n-review-cli-"));
  git("init", "--quiet", "--initial-branch=main");
  execFileSync("mkdir", ["-p", join(repo, "src"), join(repo, "locales")]);
  write("src/Old.tsx", "export const Old = () => <p>Legacy text</p>;\n");
  write("locales/en.json", '{\n  "title": "Cart"\n}\n');
  write("locales/ja.json", '{\n  "title": "カート"\n}\n');
  git("add", ".");
  git("commit", "--quiet", "-m", "base");

  git("switch", "--quiet", "-c", "feature");
  write(
    "src/Old.tsx",
    "export const Old = () => (\n  <div>\n    <p>Legacy text</p>\n    <p>New text</p>\n  </div>\n);\n",
  );
  git("commit", "--quiet", "-am", "committed change");
  write("locales/en.json", '{\n  "title": "Cart",\n  "checkout": "Checkout"\n}\n'); // uncommitted
  write("src/New.tsx", "export const New = () => <button>Buy</button>;\n"); // untracked
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("changedFiles", () => {
  it("includes committed, uncommitted and untracked changes, with added lines", async () => {
    const changes = await changedFiles("main", repo);
    const byPath = Object.fromEntries(
      changes.map((c) => [c.path, c.addedLines && [...c.addedLines]]),
    );
    expect(byPath).toEqual({
      "locales/en.json": [2, 3],
      "src/Old.tsx": [1, 2, 3, 4, 5, 6],
      "src/New.tsx": undefined, // untracked: every line is new
    });
  });
});

describe("review", () => {
  it("runs the rules on the change, using the other files on disk", async () => {
    const { findings, filesChecked } = await review({ cwd: repo, base: "main" });
    expect(filesChecked).toBe(3);
    expect(findings.map((f) => `${f.path}:${f.line} ${f.ruleId} ${f.text}`)).toEqual([
      "locales/en.json:3 locale-keys missing:checkout", // ja.json read from disk
      "src/New.tsx:1 no-hardcoded-string Buy",
      "src/Old.tsx:3 no-hardcoded-string Legacy text",
      "src/Old.tsx:4 no-hardcoded-string New text",
    ]);
  });

  it("honours .l10nrc.yml in the working tree", async () => {
    write(".l10nrc.yml", 'ignore: ["src/**"]\n');
    try {
      const { findings } = await review({ cwd: repo, base: "main" });
      expect(findings.map((f) => f.path)).toEqual(["locales/en.json"]);
    } finally {
      rmSync(join(repo, ".l10nrc.yml"));
    }
  });

  it("gives the same result when started in a subdirectory", async () => {
    const fromRoot = await review({ cwd: repo, base: "main" });
    const fromSubdir = await review({ cwd: join(repo, "src"), base: "main" });
    expect(fromSubdir.findings).toEqual(fromRoot.findings);
  });

  it("reviews every tracked file with --all", async () => {
    const { filesChecked } = await review({ cwd: repo, base: "main", all: true });
    expect(filesChecked).toBe(3); // Old.tsx, en.json, ja.json (New.tsx is untracked)
  });
});

describe("exitCode", () => {
  const finding = (severity: Finding["severity"]): Finding => ({
    ruleId: "r",
    path: "p",
    line: 1,
    column: 1,
    severity,
    message: "m",
    text: "t",
  });

  it("fails on errors by default, on warnings when asked, never when told", () => {
    expect(exitCode([finding("warning")], "error")).toBe(0);
    expect(exitCode([finding("error")], "error")).toBe(1);
    expect(exitCode([finding("warning")], "warning")).toBe(1);
    expect(exitCode([finding("error")], "never")).toBe(0);
    expect(exitCode([], "warning")).toBe(0);
  });
});
