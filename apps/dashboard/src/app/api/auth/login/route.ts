import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth-config";

// Step 1 of the OAuth flow: send the browser to GitHub with a random `state`, remembered in a
// short-lived cookie. The callback only accepts a response carrying the same state, so another
// site cannot finish a login on the user's behalf (CSRF).

export function GET(request: Request) {
  const config = authConfig();
  if (config.mode !== "github") return NextResponse.redirect(new URL("/", request.url));

  const state = randomBytes(16).toString("hex");
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", new URL("/api/auth/callback", request.url).toString());
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set("l10n_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/auth",
  });
  return response;
}
