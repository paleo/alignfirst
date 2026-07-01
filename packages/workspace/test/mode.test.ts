import { describe, expect, it } from "vitest";

import { isModeError, resolveMode } from "../src/mode.js";

describe("resolveMode", () => {
  it("is foreground when no callback URL is resolvable", () => {
    const mode = resolveMode({}, {});
    expect(isModeError(mode)).toBe(false);
    if (!isModeError(mode)) {
      expect(mode.isBackground).toBe(false);
      expect(mode.callback).toBeUndefined();
    }
  });

  it("is background with a callback when a URL and session key are present", () => {
    const mode = resolveMode(
      { sessionKey: "current" },
      { WORKSPACE_CALLBACK_URL: "http://x/hooks/agent", WORKSPACE_CALLBACK_TOKEN: "tok" },
    );
    expect(isModeError(mode)).toBe(false);
    if (!isModeError(mode)) {
      expect(mode.isBackground).toBe(true);
      expect(mode.callback).toEqual({
        url: "http://x/hooks/agent",
        token: "tok",
        sessionKey: "current",
      });
    }
  });

  it("prefers the --callback-url override over the env var", () => {
    const mode = resolveMode(
      { callbackUrl: "http://override", sessionKey: "k" },
      { WORKSPACE_CALLBACK_URL: "http://env" },
    );
    if (!isModeError(mode)) expect(mode.callback?.url).toBe("http://override");
  });

  it("fails loudly when a callback URL is set but --session-key is missing", () => {
    const mode = resolveMode({}, { WORKSPACE_CALLBACK_URL: "http://x" });
    expect(isModeError(mode)).toBe(true);
    if (isModeError(mode)) expect(mode.error).toContain("--session-key is missing");
  });
});
