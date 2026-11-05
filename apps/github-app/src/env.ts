import { readFileSync } from "node:fs";
import { z } from "zod";

// Validate configuration once at startup and fail loudly, instead of finding out
// at the first webhook that a variable is missing. (Laravel analogy: config/*.php + env(),
// but with a schema so a typo is a boot error, not a null at runtime.)

const EnvSchema = z
  .object({
    GITHUB_APP_ID: z.coerce.number().int().positive(),
    /** The PEM itself. Convenient for CI secrets / Secret Manager; "\n" escapes are accepted. */
    GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
    /** Or a path to the downloaded .pem file. Convenient for local development. */
    GITHUB_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(3000),
    /** Postgres. Set: durable job queue + review history. Unset: in-process queue, no history. */
    DATABASE_URL: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
    /** How long a shutdown waits for running reviews. Cloud Run allows 10s after SIGTERM. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  })
  .refine(
    (env) => env.GITHUB_PRIVATE_KEY !== undefined || env.GITHUB_PRIVATE_KEY_PATH !== undefined,
    {
      message: "Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH",
      path: ["GITHUB_PRIVATE_KEY"],
      // Report this together with any other problems, not only once everything else is valid.
      when: () => true,
    },
  );

export interface Env {
  GITHUB_APP_ID: number;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  PORT: number;
  DATABASE_URL?: string;
  LOG_LEVEL: string;
  LOG_FORMAT: "json" | "pretty";
  SHUTDOWN_TIMEOUT_MS: number;
}

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }

  const { GITHUB_PRIVATE_KEY, GITHUB_PRIVATE_KEY_PATH, ...rest } = result.data;
  const privateKey =
    GITHUB_PRIVATE_KEY !== undefined
      ? GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n")
      : readFile(GITHUB_PRIVATE_KEY_PATH as string);

  return { ...rest, GITHUB_PRIVATE_KEY: privateKey };
}
