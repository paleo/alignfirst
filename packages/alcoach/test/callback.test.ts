import { describe, expect, it } from "vitest";

import { buildCallbackRequest } from "../src/callback.js";
import type { CallbackConfig } from "../src/mode.js";

const CONFIG: CallbackConfig = {
  url: "http://gateway/hooks/agent",
  token: "tok-123",
  sessionKey: "current",
};

describe("buildCallbackRequest", () => {
  it("targets the callback URL with a bearer token and a JSON content type", () => {
    const req = buildCallbackRequest(CONFIG, "/proj/.plans/29/coding-sessions/s.md", "/proj");
    expect(req.url).toBe("http://gateway/hooks/agent");
    expect(req.headers.authorization).toBe("Bearer tok-123");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("carries the session key and a message that points at the relative log path", () => {
    const req = buildCallbackRequest(CONFIG, "/proj/.plans/29/coding-sessions/s.md", "/proj");
    expect(req.body.sessionKey).toBe("current");
    expect(req.body.message).toContain(".plans/29/coding-sessions/s.md");
    expect(req.body.message).not.toContain("Session ID");
  });

  it("derives a stable idempotency key from the log path", () => {
    const a = buildCallbackRequest(CONFIG, "/proj/.plans/a.md", "/proj").body.idempotencyKey;
    const b = buildCallbackRequest(CONFIG, "/proj/.plans/a.md", "/proj").body.idempotencyKey;
    const c = buildCallbackRequest(CONFIG, "/proj/.plans/b.md", "/proj").body.idempotencyKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("omits the authorization header when no token is configured", () => {
    const req = buildCallbackRequest({ ...CONFIG, token: undefined }, "/proj/.plans/a.md", "/proj");
    expect(req.headers.authorization).toBeUndefined();
  });
});
