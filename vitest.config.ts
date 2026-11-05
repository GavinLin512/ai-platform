import { defineConfig } from "vitest/config";

// One test run for the whole monorepo; each workspace is its own Vitest project.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
