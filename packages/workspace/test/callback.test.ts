import { describe, expect, it, vi } from "vitest";

import { buildCallbackRequest, fireCallback } from "../src/callback.js";
import type { CallbackConfig } from "../src/mode.js";

const CONFIG: CallbackConfig = {
  url: "http://gateway/hooks/agent",
  token: "tok-123",
  sessionKey: "current",
};

const LOG = "/repo/feat/.local-wt/logs/workspace-setup.log";

describe("buildCallbackRequest", () => {
  it("targets the callback URL with a bearer token and a JSON content type", () => {
    const req = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat");
    expect(req.url).toBe("http://gateway/hooks/agent");
    expect(req.headers.authorization).toBe("Bearer tok-123");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("carries the session key and a message that points at the relative setup log", () => {
    const req = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat");
    expect(req.body.sessionKey).toBe("current");
    expect(req.body.message).toContain(".local-wt/logs/workspace-setup.log");
    expect(req.body.message).toContain("READY:");
  });

  it("derives a stable idempotency key from the slot identity", () => {
    const a = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat").body
      .idempotencyKey;
    const b = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat").body
      .idempotencyKey;
    const c = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8120", "/repo/feat").body
      .idempotencyKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("omits the authorization header when no token is configured", () => {
    const req = buildCallbackRequest({ ...CONFIG, token: undefined }, LOG, "/repo/feat#8110", "/x");
    expect(req.headers.authorization).toBeUndefined();
  });
});

describe("fireCallback", () => {
  it("POSTs the request body as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const req = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat");
    await fireCallback(req);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway/hooks/agent",
      expect.objectContaining({ method: "POST", body: JSON.stringify(req.body) }),
    );
    vi.unstubAllGlobals();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const req = buildCallbackRequest(CONFIG, LOG, "/repo/feat#8110", "/repo/feat");
    await expect(fireCallback(req)).rejects.toThrow(/Callback POST failed/);
    vi.unstubAllGlobals();
  });
});
