import { Hono } from "hono";
import type { App } from "octokit";

type Webhooks = App["webhooks"];
type WebhookEvent = Parameters<Webhooks["receive"]>[0];

/** Only what the server needs from octokit, so tests can pass a real or a fake implementation. */
export type WebhookReceiver = Pick<Webhooks, "verify" | "receive">;

export function createServer(webhooks: WebhookReceiver): Hono {
  const server = new Hono();

  server.get("/healthz", (c) => c.json({ ok: true }));

  server.post("/api/github/webhooks", async (c) => {
    const id = c.req.header("x-github-delivery");
    const name = c.req.header("x-github-event");
    const signature = c.req.header("x-hub-signature-256");
    if (!id || !name || !signature) {
      return c.json({ error: "Missing GitHub webhook headers" }, 400);
    }

    // Verify the HMAC over the *raw* body. Parsing and re-serialising JSON first would
    // change the bytes and break the signature.
    const body = await c.req.text();
    if (!(await webhooks.verify(body, signature))) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "Body is not valid JSON" }, 400);
    }

    // GitHub gives up on a delivery after 10 seconds, and a review can take longer.
    // Acknowledge now and do the work in the background.
    // (Phase 3: move this to a queue — on Cloud Run, CPU is throttled after the response.)
    webhooks.receive({ id, name, payload } as WebhookEvent).catch((error: unknown) => {
      console.error(
        JSON.stringify({ msg: "webhook processing failed", delivery: id, error: String(error) }),
      );
    });

    return c.json({ accepted: true }, 202);
  });

  return server;
}
