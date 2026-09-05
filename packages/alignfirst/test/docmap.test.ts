import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("docmap command", () => {
  it("injects the alignfirst command form", async () => {
    const cwd = temp();
    expect((await runMain(["docmap", "--help"], { cwd })).stdout).toContain(
      "alignfirst docmap --check",
    );
    expect(
      (
        await runMain(["docmap", "--guide"], {
          cwd,
          env: { npm_config_user_agent: "npm/11" },
        })
      ).stdout,
    ).toContain("npx -y alignfirst docmap --check");
  });

  it("propagates docmap exit codes", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "bad name.md"), "# Bad\n");
    expect((await runMain(["docmap", "--check"], { cwd })).code).toBe(1);
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
