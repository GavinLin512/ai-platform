import { createHmac, timingSafeEqual } from "node:crypto";

// A signed session cookie: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
// The server can trust the payload without a session store, because only it knows the
// secret; changing one byte of the payload invalidates the signature.

export interface Session {
  login: string;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
}

export const SESSION_COOKIE = "l10n_session";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const mac = (data: string, secret: string) =>
  createHmac("sha256", secret).update(data).digest("base64url");

export function signSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Session | undefined {
  const [payload, signature] = token?.split(".") ?? [];
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(mac(payload, secret));
  const actual = Buffer.from(signature);
  // Constant-time comparison: how long it takes must not reveal how many bytes matched.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return typeof session.login === "string" && session.exp > now ? session : undefined;
  } catch {
    return undefined;
  }
}
