import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  // @l10n-review/db ships TypeScript source; let Next compile it like app code.
  transpilePackages: ["@l10n-review/db"],
  // A self-contained server in .next/standalone for the Docker image.
  output: "standalone",
  // In a monorepo, trace files from the repository root, or the workspace packages are missed.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default config;
