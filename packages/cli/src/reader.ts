import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoReader } from "@l10n-review/core";

/** The third RepoReader: the working tree on disk (the others are in-memory and GitHub). */
export function fsReader(root: string): RepoReader {
  const missing = (error: unknown) =>
    (error as { code?: string }).code === "ENOENT" ||
    (error as { code?: string }).code === "ENOTDIR";
  return {
    async readFile(path) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async listDir(path) {
      try {
        const entries = await readdir(join(root, path), { withFileTypes: true });
        return entries
          .filter((e) => e.isFile() || e.isDirectory())
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? ("dir" as const) : ("file" as const),
          }));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
  };
}
