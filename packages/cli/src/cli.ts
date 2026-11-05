// l10n-review check [--base <ref>] [--all] [--format text|json|github] [--fail-on error|warning|never] [--ai]

import { parseArgs } from "node:util";
import { formatUsd } from "@l10n-review/ai";
import { formatGithub, formatJson, formatText } from "./format.ts";
import { defaultBase } from "./git.ts";
import { exitCode, type FailOn, review } from "./review.ts";

const HELP = `Usage: l10n-review [check] [options]

Reviews the localization of what this branch changed (committed and uncommitted) against a
base branch: hardcoded UI strings, locale keys, placeholders, Intl formatting. Configure it
with .l10nrc.yml at the repository root.

Options:
  --base <ref>        compare against this branch or commit (default: origin/HEAD, else main)
  --all               review every tracked file instead of the change
  --format <format>   text (default), json, or github (Actions annotations)
  --fail-on <level>   exit 1 on error (default), warning, or never
  --ai                also run the LLM checks; needs ANTHROPIC_API_KEY and costs money
  -h, --help          show this help
  -v, --version       print the version
`;

const VERSION = "0.1.0";

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      all: { type: "boolean", default: false },
      format: { type: "string", default: "text" },
      "fail-on": { type: "string", default: "error" },
      ai: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = positionals[0] ?? "check";
  if (command !== "check") throw new UsageError(`Unknown command "${command}".`);
  if (!["text", "json", "github"].includes(values.format)) {
    throw new UsageError(`--format must be text, json or github, not "${values.format}".`);
  }
  if (!["error", "warning", "never"].includes(values["fail-on"])) {
    throw new UsageError(`--fail-on must be error, warning or never, not "${values["fail-on"]}".`);
  }
  if (values.ai && !process.env.ANTHROPIC_API_KEY) {
    throw new UsageError("--ai needs ANTHROPIC_API_KEY.");
  }

  const cwd = process.cwd();
  const { findings, filesChecked, meter } = await review({
    cwd,
    base: values.base ?? (await defaultBase(cwd)),
    all: values.all,
    ai: values.ai,
  });

  const output =
    values.format === "json"
      ? formatJson(findings)
      : values.format === "github"
        ? formatGithub(findings)
        : formatText(findings, filesChecked);
  if (output) process.stdout.write(`${output}\n`);
  if (values.ai && values.format === "text") {
    process.stderr.write(`LLM: ${meter.records.length} calls, ${formatUsd(meter.totalCostUsd)}\n`);
  }
  return exitCode(findings, values["fail-on"] as FailOn);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `l10n-review: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (error instanceof UsageError) process.stderr.write("Run l10n-review --help for usage.\n");
    process.exitCode = 2;
  },
);
