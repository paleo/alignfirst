import { describe, expect, it } from "vitest";

import { type PackageManagerCommands, renderGuide } from "../src/guide.js";

const NPM: PackageManagerCommands = {
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

const PNPM: PackageManagerCommands = {
  workspace: { base: "pnpm workspace", withArgs: "pnpm workspace" },
  dev: { base: "pnpm dev", withArgs: "pnpm dev" },
};

describe("renderGuide", () => {
  it("renders npm commands with the `--` separator for forwarded args", () => {
    const guide = renderGuide(NPM);
    expect(guide).toContain("npm run workspace -- setup fix/123 -c");
    expect(guide).toContain("npm run dev -- up");
    // Bare foreground takes no forwarded args, so no separator.
    expect(guide).toMatch(/^npm run dev {2,}#/m);
  });

  it("renders pnpm commands without a separator", () => {
    const guide = renderGuide(PNPM);
    expect(guide).toContain("pnpm workspace setup fix/123 -c");
    expect(guide).toContain("pnpm dev up");
    expect(guide).not.toContain("pnpm dev --");
  });

  it("aligns the `#` comments within a command block", () => {
    const guide = renderGuide(NPM);
    const block = guide.slice(guide.indexOf("## Dev server"), guide.indexOf("**Concurrent cap."));
    const commentColumns = block
      .split("\n")
      .filter((line) => line.startsWith("npm run dev ") && line.includes(" # "))
      .map((line) => line.indexOf(" # "));
    expect(commentColumns.length).toBeGreaterThan(1);
    expect(new Set(commentColumns).size).toBe(1);
  });
});
