import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAddedLines } from "@l10n-review/core";

const run = promisify(execFile);

/** Runs git with paths printed as-is (no octal escaping of 中文 file names). */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export interface Change {
  path: string;
  /** Undefined: the whole file is new (an untracked file). */
  addedLines?: Set<number>;
}

/**
 * The repository's top directory. git prints paths relative to it, and .l10nrc.yml lives there,
 * so everything runs from here even when the command is started in a subdirectory.
 */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git repository.`);
  }
}

/** The branch the work will merge into: origin/HEAD if the clone knows it, else main. */
export async function defaultBase(cwd: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd)).trim();
  } catch {
    return "main";
  }
}

/**
 * Files changed since the branch left `base`, with the lines they added, including uncommitted
 * edits and new untracked files. `--merge-base` diffs against the fork point, so commits that
 * landed on `base` meanwhile are not counted as this branch's changes.
 */
export async function changedFiles(base: string, cwd: string): Promise<Change[]> {
  const diff = await git(
    [
      "diff",
      "--merge-base",
      base,
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--diff-filter=ACMR",
      "--find-renames",
    ],
    cwd,
  );
  const changes: Change[] = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1];
    if (path) changes.push({ path, addedLines: parseAddedLines(block) });
  }
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], cwd);
  for (const path of untracked.split("\n").filter(Boolean)) changes.push({ path });
  return changes;
}

/** Every tracked file, for `--all`: review the whole repository, not just a change. */
export async function allFiles(cwd: string): Promise<Change[]> {
  return (await git(["ls-files"], cwd))
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ path }));
}
