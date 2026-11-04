import type { Octokit } from "octokit";
import { cachedReader, type RepoReader } from "../core/index.ts";

/** A RepoReader backed by the GitHub contents API, pinned to one commit. */
export function githubReader(
  octokit: Octokit,
  target: { owner: string; repo: string; ref: string },
): RepoReader {
  return cachedReader({
    async readFile(path) {
      const data = await getContent(octokit, { ...target, path });
      // Directories come back as arrays; files over 1 MB come back with encoding "none".
      if (!data || Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") {
        return undefined;
      }
      return Buffer.from(data.content, "base64").toString("utf8");
    },
    async listDir(path) {
      const data = await getContent(octokit, { ...target, path });
      if (!Array.isArray(data)) return [];
      return data
        .filter((entry) => entry.type === "file" || entry.type === "dir")
        .map((entry) => ({ name: entry.name, type: entry.type as "file" | "dir" }));
    },
  });
}

/** getContent, but a missing path is `undefined` instead of an exception. */
async function getContent(
  octokit: Octokit,
  params: { owner: string; repo: string; ref: string; path: string },
) {
  try {
    return (await octokit.rest.repos.getContent(params)).data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}
