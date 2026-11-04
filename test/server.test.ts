import { createHmac } from "node:crypto";
import { App } from "octokit";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.ts";

const SECRET = "test-secret";

// A real octokit App: the signature check below is the real one, not a mock.
// The private key is never used because no handler calls the GitHub API.
function setup() {
  const app = new App({ appId: 1, privateKey: "unused-in-tests", webhooks: { secret: SECRET } });
  const onPing = vi.fn();
  app.webhooks.on("ping", onPing);
  return { server: createServer(app.webhooks), onPing };
}

/** What GitHub does: HMAC-SHA256 of the raw body with the shared secret. */
function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function deliver(server: ReturnType<typeof setup>["server"], body: string, signature?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
    "x-github-event": "ping",
  };
  if (signature) headers["x-hub-signature-256"] = signature;
  return server.request("/api/github/webhooks", { method: "POST", headers, body });
}

const pingBody = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });

describe("server", () => {
  it("answers health checks", async () => {
    const res = await setup().server.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a correctly signed delivery and dispatches it", async () => {
    const { server, onPing } = setup();
    const res = await deliver(server, pingBody, sign(pingBody));

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(onPing).toHaveBeenCalledOnce());
    expect(onPing.mock.calls[0]?.[0]).toMatchObject({ id: "delivery-1", name: "ping" });
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const { server, onPing } = setup();
    const res = await deliver(server, pingBody, sign(pingBody, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(onPing).not.toHaveBeenCalled();
  });

  it("rejects a body that was tampered with after signing", async () => {
    const { server } = setup();
    const res = await deliver(server, pingBody.replace("awesome", "evil"), sign(pingBody));
    expect(res.status).toBe(401);
  });

  it("rejects requests without GitHub headers", async () => {
    const res = await deliver(setup().server, pingBody);
    expect(res.status).toBe(400);
  });
});
