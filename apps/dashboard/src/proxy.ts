import { type NextRequest, NextResponse } from "next/server";
import { authConfig } from "@/lib/auth-config";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

// Runs before every matched request (Next 16 renamed middleware.ts to proxy.ts).
// Pages need a valid session; the login flow and the health check do not.

export function proxy(request: NextRequest) {
  const config = authConfig();
  if (config.mode === "off") return NextResponse.next();
  if (config.mode === "misconfigured") {
    return new NextResponse(
      `Dashboard authentication is not configured: set ${config.missing.join(", ")}.`,
      {
        status: 503,
      },
    );
  }

  const session = verifySession(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (session && config.allowedUsers.has(session.login.toLowerCase())) return NextResponse.next();
  return NextResponse.redirect(new URL("/api/auth/login", request.url));
}

export const config = {
  // Everything except the auth routes, the health check and Next's static assets.
  matcher: ["/((?!api/auth|healthz|_next/static|_next/image|favicon.ico).*)"],
};
