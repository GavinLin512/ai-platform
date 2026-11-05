// Who may see the dashboard: GitHub users you list, signed in with the GitHub App's OAuth
// credentials (App settings → General → Client ID / "Generate a new client secret").
//
//   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
//   DASHBOARD_ALLOWED_USERS=alice,bob      GitHub logins, comma-separated
//   DASHBOARD_SESSION_SECRET=…             32+ random characters (openssl rand -hex 32)
//
// Without them, the dashboard is open in development and refuses to serve in production.

export type AuthConfig =
  | {
      mode: "github";
      clientId: string;
      clientSecret: string;
      sessionSecret: string;
      allowedUsers: Set<string>;
    }
  | { mode: "off" }
  | { mode: "misconfigured"; missing: string[] };

const REQUIRED = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "DASHBOARD_ALLOWED_USERS",
  "DASHBOARD_SESSION_SECRET",
] as const;

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length === 0) {
    const sessionSecret = env.DASHBOARD_SESSION_SECRET as string;
    if (sessionSecret.length < 32) {
      return { mode: "misconfigured", missing: ["DASHBOARD_SESSION_SECRET (32+ characters)"] };
    }
    return {
      mode: "github",
      clientId: env.GITHUB_OAUTH_CLIENT_ID as string,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET as string,
      sessionSecret,
      allowedUsers: new Set(
        (env.DASHBOARD_ALLOWED_USERS as string)
          .split(",")
          .map((login) => login.trim().toLowerCase())
          .filter(Boolean),
      ),
    };
  }
  // Fail closed: a production deployment without auth settings serves nothing.
  return env.NODE_ENV === "production" ? { mode: "misconfigured", missing } : { mode: "off" };
}
