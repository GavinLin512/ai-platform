import type { DirEntry, RepoReader } from "./types.ts";

/** A RepoReader over an in-memory map of path → content. Used by tests and as a fallback. */
export function memoryReader(files: Readonly<Record<string, string>>): RepoReader {
  return {
    readFile: async (path) => files[path],
    listDir: async (dir) => {
      const prefix = dir === "" ? "" : `${dir.replace(/\/+$/, "")}/`;
      const entries = new Map<string, DirEntry["type"]>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        if (name) entries.set(name, rest.length > 0 ? "dir" : "file");
      }
      return [...entries].map(([name, type]) => ({ name, type }));
    },
  };
}

/**
 * Remembers every read, so several rules (and several changed files) asking for the
 * same locale file cost one request. Caches the promise, so concurrent reads share it too.
 */
export function cachedReader(reader: RepoReader): RepoReader {
  return {
    readFile: memoize((path) => reader.readFile(path)),
    listDir: memoize((path) => reader.listDir(path)),
  };
}

function memoize<T>(load: (path: string) => Promise<T>): (path: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (path) => {
    const cached = cache.get(path);
    if (cached) return cached;
    const result = load(path);
    cache.set(path, result);
    return result;
  };
}
