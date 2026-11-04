import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/env.ts";

const base = { GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "s3cret" };

describe("loadEnv", () => {
  it("parses an inline key and turns literal \\n into newlines", () => {
    expect(
      loadEnv({ ...base, GITHUB_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----" }),
    ).toEqual({
      GITHUB_APP_ID: 123,
      GITHUB_PRIVATE_KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      GITHUB_WEBHOOK_SECRET: "s3cret",
      PORT: 3000,
    });
  });

  it("reads the key from GITHUB_PRIVATE_KEY_PATH", () => {
    const readFile = vi.fn(() => "-----BEGIN KEY-----\nfrom-file\n-----END KEY-----\n");
    const env = loadEnv({ ...base, GITHUB_PRIVATE_KEY_PATH: "./app.pem" }, readFile);

    expect(readFile).toHaveBeenCalledWith("./app.pem");
    expect(env.GITHUB_PRIVATE_KEY).toContain("from-file");
  });

  it("prefers the inline key when both are set", () => {
    const readFile = vi.fn(() => "from-file");
    const env = loadEnv(
      { ...base, GITHUB_PRIVATE_KEY: "inline", GITHUB_PRIVATE_KEY_PATH: "./app.pem" },
      readFile,
    );

    expect(env.GITHUB_PRIVATE_KEY).toBe("inline");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("names every missing variable at once", () => {
    expect(() => loadEnv({})).toThrow(
      /GITHUB_APP_ID[\s\S]*GITHUB_WEBHOOK_SECRET[\s\S]*Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH/,
    );
  });

  it("rejects a non-numeric app id", () => {
    expect(() => loadEnv({ ...base, GITHUB_PRIVATE_KEY: "k", GITHUB_APP_ID: "abc" })).toThrow(
      /GITHUB_APP_ID/,
    );
  });
});
