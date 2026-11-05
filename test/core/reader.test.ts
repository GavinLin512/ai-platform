import { describe, expect, it, vi } from "vitest";
import { cachedReader, memoryReader, type RepoReader } from "../../src/core/index.ts";

describe("memoryReader", () => {
  const reader = memoryReader({
    "locales/en.json": "{}",
    "locales/zh-TW.json": "{}",
    "public/locales/ja/common.json": "{}",
    "README.md": "#",
  });

  it("reads files and returns undefined for missing ones", async () => {
    expect(await reader.readFile("locales/en.json")).toBe("{}");
    expect(await reader.readFile("locales/fr.json")).toBeUndefined();
  });

  it("lists files and directories one level deep", async () => {
    expect(await reader.listDir("locales")).toEqual([
      { name: "en.json", type: "file" },
      { name: "zh-TW.json", type: "file" },
    ]);
    expect(await reader.listDir("public/locales/")).toEqual([{ name: "ja", type: "dir" }]);
    expect(await reader.listDir("")).toEqual([
      { name: "locales", type: "dir" },
      { name: "public", type: "dir" },
      { name: "README.md", type: "file" },
    ]);
    expect(await reader.listDir("missing")).toEqual([]);
  });
});

describe("cachedReader", () => {
  it("asks the underlying reader once per path, even for concurrent reads", async () => {
    const inner: RepoReader = {
      readFile: vi.fn(async () => "content"),
      listDir: vi.fn(async () => []),
    };
    const reader = cachedReader(inner);

    await Promise.all([reader.readFile("a.json"), reader.readFile("a.json")]);
    await reader.readFile("a.json");
    await reader.listDir("locales");
    await reader.listDir("locales");

    expect(inner.readFile).toHaveBeenCalledOnce();
    expect(inner.listDir).toHaveBeenCalledOnce();
  });
});
