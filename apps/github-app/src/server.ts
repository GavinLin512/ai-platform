import { Hono } from "hono";
import type { App } from "octokit";
import type { Logger } from "./logger.ts";

type Webhooks = App["webhooks"];
type WebhookEvent = Parameters<Webhooks["receive"]>[0];

/** Only what the server needs from octokit, so tests can pass a real or a fake implementation. */
export type WebhookReceiver = Pick<Webhooks, "verify" | "receive">;

export interface ServerOptions {
  /** For /readyz: can this instance do its job right now (e.g. is the database reachable)? */
  ready?: () => Promise<boolean>;
  log?: Pick<Logger, "error">;
}

export function createServer(webhooks: WebhookReceiver, options: ServerOptions = {}): Hono {
  const server = new Hono();

  // Liveness: the process is up. Restarting it would not help with anything else.
  server.get("/healthz", (c) => c.json({ ok: true }));

  // Readiness: send me traffic. A failing check takes the instance out of rotation
  // (Kubernetes readinessProbe) without restarting it.
  server.get("/readyz", async (c) => {
    const ready = options.ready ? await options.ready() : true;
    return c.json({ ready }, ready ? 200 : 503);
  });

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

    // Handlers only enqueue a job (milliseconds), so we can wait for them: if enqueueing
    // fails, GitHub gets a 500, marks the delivery failed, and it can be redelivered.
    try {
      await webhooks.receive({ id, name, payload } as WebhookEvent);
    } catch (error) {
      options.log?.error({ err: error, delivery: id }, "webhook handling failed");
      return c.json({ error: "Could not handle the event" }, 500);
    }
    return c.json({ accepted: true }, 202);
  });

  return server;
}
