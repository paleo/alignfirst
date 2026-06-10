import { describe, expect, it } from "vitest";
import { addInitScripts, type PackageJsonScripts } from "../src/cli.js";

describe("addInitScripts", () => {
  it("adds the four scripts to a package.json without scripts", () => {
    const pkg: PackageJsonScripts = {};
    const added = addInitScripts(pkg);
    expect(added).toEqual(["env:build", "env:up", "env:down", "e2e"]);
    expect(pkg.scripts).toEqual({
      "env:build": "openclaw-test env build",
      "env:up": "openclaw-test env up",
      "env:down": "openclaw-test env down",
      e2e: "openclaw-test run",
    });
  });

  it("never overwrites an existing script", () => {
    const pkg: PackageJsonScripts = { scripts: { e2e: "custom command" } };
    const added = addInitScripts(pkg);
    expect(added).toEqual(["env:build", "env:up", "env:down"]);
    expect(pkg.scripts?.e2e).toBe("custom command");
  });

  it("returns an empty list when every script is already present", () => {
    const pkg: PackageJsonScripts = {};
    addInitScripts(pkg);
    expect(addInitScripts(pkg)).toEqual([]);
  });
});
