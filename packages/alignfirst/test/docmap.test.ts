import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeCompanionProject, makeTempDir, runMain } from "./helpers.js";

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

  it("passes the companion docs as --root unless one is given", async () => {
    const { root, home, project, companion } = makeCompanionProject({ docs: true });
    dirs.push(root);
    mkdirSync(join(companion, "docs"), { recursive: true });
    writeFileSync(join(companion, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "local.md"), "---\ntitle: Local\n---\n\n# Local\n");
    const companionDocs = await runMain(["docmap"], { cwd: project, home });
    expect(companionDocs.stdout).toContain("topic.md` — Topic");
    expect(companionDocs.stdout).not.toContain("Local");
    const explicit = await runMain(["docmap", "--root", "docs"], { cwd: project, home });
    expect(explicit.stdout).toContain("`docs/local.md` — Local");
    expect(explicit.stdout).not.toContain("Topic");
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
