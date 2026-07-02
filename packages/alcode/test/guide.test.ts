import { describe, expect, it } from "vitest";

import { renderGuide } from "../src/guide.js";

describe("renderGuide", () => {
  it("renders the generic variant with the pointer to the OpenClaw one", () => {
    const guide = renderGuide("generic");
    expect(guide).toMatch(/^# AlignFirst Delegation Guide\n/);
    expect(guide).toContain("alcode --openclaw-guide");
    expect(guide).not.toContain("background: true");
  });

  it("renders the OpenClaw variant with its run and wake instructions", () => {
    const guide = renderGuide("openclaw");
    expect(guide).toMatch(/^# AlignFirst Delegation Guide \(OpenClaw\)\n/);
    expect(guide).toContain("`background: true` and `timeout: 0`");
    expect(guide).toContain("plain heartbeat poll");
    expect(guide).toContain("`~` is not expanded there");
  });

  it("shares the protocol manual across variants", () => {
    for (const variant of ["generic", "openclaw"] as const) {
      const guide = renderGuide(variant);
      expect(guide).toContain("## CLI reference");
      expect(guide).toContain("## Spec-Plan-Execute workflow");
      expect(guide).toContain("Read the run's session file");
    }
  });

  it("resolves every tag and never names the wrapped coding agent", () => {
    for (const variant of ["generic", "openclaw"] as const) {
      const guide = renderGuide(variant);
      expect(guide).not.toContain("{{");
      expect(guide.toLowerCase()).not.toContain("claude");
    }
  });
});
