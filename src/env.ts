import { z } from "zod";

// Validate configuration once at startup and fail loudly, instead of finding out
// at the first webhook that a variable is missing. (Laravel analogy: config/*.php + env(),
// but with a schema so a typo is a boot error, not a null at runtime.)

const EnvSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z
    .string()
    .min(1)
    // Allow the PEM to be stored on one line with literal "\n" (common in .env files and CI secrets).
    .transform((key) => key.replace(/\\n/g, "\n")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
