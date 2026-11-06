import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configureGit,
  initRepository,
  makeCompanionProject,
  makeTempDir,
  runMain,
} from "./helpers.js";

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
          env: { npm_config_user_agent: "npm/11", npm_command: "exec", npm_lifecycle_event: "npx" },
        })
      ).stdout,
    ).toContain("npx -y alignfirst docmap --check");
  });

  it.each(["context", "docmap"])(
    "%s selects project docs from nested cwd, ignoring nested decoys",
    async (command) => {
      const root = temp();
      configureGit(root);
      const project = join(root, "project");
      initRepository(project);
      const nested = join(project, "src");
      mkdirSync(nested);
      mkdirSync(join(project, "docs"));
      writeFileSync(join(project, "docs", "selected.md"), "# Selected\n");

      const atRoot = await runMain([command], { cwd: project });
      expect(atRoot).toMatchObject({ code: 0, stderr: "" });
      expect(atRoot.stdout).toContain("`docs/selected.md` — Selected");
      expect(atRoot.stdout).not.toContain("--root");

      for (const withDecoy of [false, true]) {
        if (withDecoy) {
          mkdirSync(join(nested, "docs"));
          writeFileSync(join(nested, "docs", "decoy.md"), "# Decoy\n");
        }
        const result = await runMain([command], { cwd: nested });
        expect(result).toMatchObject({ code: 0, stderr: "" });
        expect(result.stdout).toContain("`../docs/selected.md` — Selected");
        expect(result.stdout).not.toContain("decoy.md");
        expect(result.stdout).toContain(`alignfirst docmap --root ${join(project, "docs")}`);
      }

      if (command === "docmap") {
        const explicit = await runMain(["docmap", "--root", "docs"], { cwd: nested });
        expect(explicit).toMatchObject({ code: 0, stderr: "" });
        expect(explicit.stdout).toContain("`docs/decoy.md` — Decoy");
        expect(explicit.stdout).not.toContain("selected.md");
      }
    },
  );

  it("passes the companion docs as --root unless one is given", async () => {
    const { root, home, project, companion } = makeCompanionProject({ docs: "companion" });
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

    const nested = join(project, "src");
    mkdirSync(join(nested, "docs"), { recursive: true });
    writeFileSync(join(nested, "docs", "decoy.md"), "# Decoy\n");
    for (const command of ["context", "docmap"]) {
      const result = await runMain([command], { cwd: nested, home });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("topic.md` — Topic");
      expect(result.stdout).not.toContain("local.md");
      expect(result.stdout).not.toContain("decoy.md");
    }
    const nestedExplicit = await runMain(["docmap", "--root", "docs"], {
      cwd: nested,
      home,
    });
    expect(nestedExplicit).toMatchObject({ code: 0, stderr: "" });
    expect(nestedExplicit.stdout).toContain("`docs/decoy.md` — Decoy");
    expect(nestedExplicit.stdout).not.toContain("topic.md");
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
