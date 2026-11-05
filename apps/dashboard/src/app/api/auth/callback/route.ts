import { type NextRequest, NextResponse } from "next/server";
import { authConfig } from "@/lib/auth-config";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "@/lib/session";

// Step 2: GitHub sends the browser back with ?code&state. Exchange the code for a token
// (server to server, with the client secret), ask GitHub who the user is, check the allowlist,
// then issue our own signed session cookie. The GitHub token is not kept.

export async function GET(request: NextRequest) {
  const config = authConfig();
  if (config.mode !== "github") return NextResponse.redirect(new URL("/", request.url));

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || state !== request.cookies.get("l10n_oauth_state")?.value) {
    return new NextResponse("Login expired or invalid. Try again from the dashboard.", {
      status: 400,
    });
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return new NextResponse("GitHub refused the login.", { status: 502 });

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
    },
  });
  const user = (await userResponse.json()) as { login?: string };
  if (!user.login) return new NextResponse("Could not read your GitHub account.", { status: 502 });

  if (!config.allowedUsers.has(user.login.toLowerCase())) {
    return new NextResponse(`@${user.login} is not allowed to view this dashboard.`, {
      status: 403,
    });
  }

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(
    SESSION_COOKIE,
    signSession({ login: user.login, exp: Date.now() + SESSION_TTL_MS }, config.sessionSecret),
    {
      httpOnly: true, // not readable from JavaScript, so an XSS bug cannot steal it
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_MS / 1000,
      path: "/",
    },
  );
  response.cookies.delete("l10n_oauth_state");
  return response;
}
