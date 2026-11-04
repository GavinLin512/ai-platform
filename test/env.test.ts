import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.ts";

const valid = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
  GITHUB_WEBHOOK_SECRET: "s3cret",
};

describe("loadEnv", () => {
  it("parses and normalises valid configuration", () => {
    expect(loadEnv(valid)).toEqual({
      GITHUB_APP_ID: 123,
      GITHUB_PRIVATE_KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      GITHUB_WEBHOOK_SECRET: "s3cret",
      PORT: 3000,
    });
  });

  it("names every missing variable", () => {
    expect(() => loadEnv({})).toThrow(
      /GITHUB_APP_ID[\s\S]*GITHUB_PRIVATE_KEY[\s\S]*GITHUB_WEBHOOK_SECRET/,
    );
  });

  it("rejects a non-numeric app id", () => {
    expect(() => loadEnv({ ...valid, GITHUB_APP_ID: "abc" })).toThrow(/GITHUB_APP_ID/);
  });
});
