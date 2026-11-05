import { describe, expect, it } from "vitest";
import { authConfig } from "../src/lib/auth-config.ts";
import { signSession, verifySession } from "../src/lib/session.ts";

const SECRET = "x".repeat(32);

describe("signed session cookie", () => {
  const token = signSession({ login: "GavinLin512", exp: 2_000 }, SECRET);

  it("round-trips a valid session", () => {
    expect(verifySession(token, SECRET, 1_000)).toEqual({ login: "GavinLin512", exp: 2_000 });
  });

  it("rejects an expired session", () => {
    expect(verifySession(token, SECRET, 3_000)).toBeUndefined();
  });

  it("rejects a token signed with another secret", () => {
    expect(
      verifySession(signSession({ login: "a", exp: 2_000 }, "y".repeat(32)), SECRET, 1_000),
    ).toBeUndefined();
  });

  it("rejects a payload changed after signing", () => {
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ login: "admin", exp: 9e15 })).toString("base64url");
    expect(verifySession(`${forged}.${signature}`, SECRET, 1_000)).toBeUndefined();
  });

  it("rejects garbage", () => {
    for (const bad of [undefined, "", "abc", "a.b.c", "."]) {
      expect(verifySession(bad, SECRET, 1_000)).toBeUndefined();
    }
  });
});

describe("authConfig", () => {
  const full = {
    GITHUB_OAUTH_CLIENT_ID: "id",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
    DASHBOARD_ALLOWED_USERS: " Alice , bob,",
    DASHBOARD_SESSION_SECRET: SECRET,
  };

  it("enables GitHub sign-in with a case-insensitive allowlist", () => {
    const config = authConfig(full);
    expect(config.mode).toBe("github");
    if (config.mode === "github") expect([...config.allowedUsers]).toEqual(["alice", "bob"]);
  });

  it("is open in development but fails closed in production", () => {
    expect(authConfig({ NODE_ENV: "development" })).toEqual({ mode: "off" });
    expect(authConfig({ NODE_ENV: "production", GITHUB_OAUTH_CLIENT_ID: "id" })).toEqual({
      mode: "misconfigured",
      missing: [
        "GITHUB_OAUTH_CLIENT_SECRET",
        "DASHBOARD_ALLOWED_USERS",
        "DASHBOARD_SESSION_SECRET",
      ],
    });
  });

  it("refuses a short session secret", () => {
    expect(authConfig({ ...full, DASHBOARD_SESSION_SECRET: "short" }).mode).toBe("misconfigured");
  });
});
