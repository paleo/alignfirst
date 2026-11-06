import { createCommand } from "@alignfirst/docmap/invocation";
import { describe, expect, it } from "vitest";

import { type GuideLayout, renderGuide } from "../src/guide.js";
const LAYOUT: GuideLayout = {
  runtimeDir: ".local-wt",
  sharedDirs: [".shared"],
  hasDevServer: true,
};

describe("renderGuide", () => {
  it("keeps replacement-pattern characters literal in commands and layout", () => {
    const token = "$&";
    const workspace = createCommand(`alignfirst${token}`, ["workspace"]);
    const dev = createCommand(`alignfirst${token}`, ["dev"]);
    const runtimeDir = `.runtime-${token}`;
    const sharedDir = `.shared-${token}`;
    const guide = renderGuide(
      { workspace, dev },
      { ...LAYOUT, runtimeDir, sharedDirs: [sharedDir] },
    );
    expect(guide).toContain(workspace.withArgs);
    expect(guide).toContain(dev.withArgs);
    expect(guide).toContain(runtimeDir);
    expect(guide).toContain(sharedDir);
  });
});
