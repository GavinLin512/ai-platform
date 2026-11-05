import { defineProject } from "vitest/config";

// These tests share one database and truncate tables between cases, so run the files one
// after another instead of in parallel, or they wipe each other's data.
export default defineProject({
  test: { fileParallelism: false },
});
