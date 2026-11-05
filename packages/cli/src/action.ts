// The GitHub Action entry point (action.yml at the repository root runs the bundled file).
// Inputs arrive as INPUT_<NAME> environment variables; findings go out as workflow commands,
// which GitHub shows as annotations on the pull request's "Files changed" tab.

import { appendFile, readFile } from "node:fs/promises";
import { formatUsd } from "@l10n-review/ai";
import { count, formatGithub, formatSummary } from "./format.ts";
import { exitCode, type FailOn, review } from "./review.ts";

/** INPUT_FAIL-ON for "fail-on": GitHub upper-cases the name and keeps the dashes. */
export const input = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";

/** The input if given, else the pull request's base commit, else the base branch name. */
export async function resolveBase(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = input("base", env);
  if (explicit) return explicit;
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
        pull_request?: { base?: { sha?: string } };
      };
      if (event.pull_request?.base?.sha) return event.pull_request.base.sha;
    } catch {
      // Not a pull_request event, or no payload: fall through.
    }
  }
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  throw new Error('Set the "base" input: this is not a pull_request event.');
}

async function main(): Promise<number> {
  const failOn = input("fail-on") || "error";
  if (!["error", "warning", "never"].includes(failOn)) {
    throw new Error(`"fail-on" must be error, warning or never, not "${failOn}".`);
  }
  const apiKey = input("anthropic-api-key");
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;

  const { findings, filesChecked, meter } = await review({
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    base: await resolveBase(),
    ai: Boolean(apiKey),
  });

  const annotations = formatGithub(findings);
  if (annotations) process.stdout.write(`${annotations}\n`);
  process.stdout.write(
    `l10n-review: ${count(findings.length, "issue")} in ${count(filesChecked, "file")}\n`,
  );
  if (apiKey) {
    process.stdout.write(
      `l10n-review: ${meter.records.length} LLM calls, ${formatUsd(meter.totalCostUsd)}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, formatSummary(findings, filesChecked));
  }
  return exitCode(findings, failOn as FailOn);
}

// Only run inside GitHub Actions, so tests can import the helpers above.
if (process.env.GITHUB_ACTIONS === "true" && !process.env.VITEST) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`::error::l10n-review failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
