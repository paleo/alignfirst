import { describe, expect, it } from "vitest";

import { renderGuide } from "../src/guide.js";
import { CLAUDE_DEFAULT_MODELS, CODEX_DEFAULT_MODELS } from "../src/models.js";

describe("renderGuide", () => {
  it("renders the generic variant with the pointer to the OpenClaw one", () => {
    const guide = renderGuide("generic", "claude", CLAUDE_DEFAULT_MODELS);
    expect(guide).toMatch(/^# AlignFirst Delegation Guide\n/);
    expect(guide).toContain("alcode --openclaw-guide");
    expect(guide).not.toContain("background: true");
  });

  it("renders the OpenClaw variant with its run and wake instructions", () => {
    const guide = renderGuide("openclaw", "claude", CLAUDE_DEFAULT_MODELS);
    expect(guide).toMatch(/^# AlignFirst Delegation Guide \(OpenClaw\)\n/);
    expect(guide).toContain("`background: true` and `timeoutSeconds: 0`");
    expect(guide).toContain("plain heartbeat poll");
    expect(guide).toContain("`~` is not expanded there");
  });

  it("shares the introduction and the CLI reference across variants", () => {
    for (const variant of ["generic", "openclaw"] as const) {
      const guide = renderGuide(variant, "claude", CLAUDE_DEFAULT_MODELS);
      expect(guide).toContain("Never implement, investigate, or modify the codebase yourself");
      expect(guide).toContain("## CLI reference");
      expect(guide).toContain("alcode status <session-file>");
      expect(guide).toContain("alcode usage");
      expect(guide).toContain("current usage limits and reset times");
      expect(guide).toContain("## Spec-Plan-Execute workflow");
      expect(guide).toContain("Stop AAD now. Start a spec instead (alignfirst).");
      expect(guide).toContain("`fable`, `opus`, `sonnet`, `haiku`");
    }
  });

  it("requires stale-run reconciliation before completion reporting", () => {
    for (const variant of ["generic", "openclaw"] as const) {
      const guide = renderGuide(variant, "claude", CLAUDE_DEFAULT_MODELS);
      expect(guide).toContain("Run `alcode status <session-file>`");
    }
  });

  it("renders the host's model list when one is configured", () => {
    const guide = renderGuide("generic", "claude", ["sonnet", "haiku"]);
    expect(guide).toContain("`sonnet`, `haiku`");
    expect(guide).not.toContain("`fable`");
  });

  it("resolves every tag and keeps selected-agent defaults isolated", () => {
    for (const variant of ["generic", "openclaw"] as const) {
      const guide = renderGuide(variant, "codex", CODEX_DEFAULT_MODELS);
      expect(guide).not.toContain("{{");
      expect(guide).toContain("`sol`, `terra`, `luna`");
      expect(guide).not.toContain("`fable`");
      expect(guide).not.toContain("claude");
    }
  });
});
