// Liveness for Kubernetes / Cloud Run. Public: the proxy lets it through without a session.
export function GET() {
  return Response.json({ ok: true });
}
