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
  it.each([
    ["docmap", false],
    ["context", true],
  ] as const)(
    "%s selects project docs from nested cwd with decoy=%s",
    async (command, withDecoy) => {
      const root = temp();
      configureGit(root);
      const project = join(root, "project");
      initRepository(project);
      const nested = join(project, "src");
      mkdirSync(nested);
      mkdirSync(join(project, "docs"));
      writeFileSync(join(project, "docs", "selected.md"), "# Selected\n");

      if (command === "docmap") {
        const atRoot = await runMain([command], { cwd: project });
        expect(atRoot).toMatchObject({ code: 0, stderr: "" });
        expect(atRoot.stdout).toContain("docs/selected.md");
        expect(atRoot.stdout).not.toContain("--root");
      }
      if (withDecoy) {
        mkdirSync(join(nested, "docs"));
        writeFileSync(join(nested, "docs", "decoy.md"), "# Decoy\n");
      }
      const result = await runMain([command], { cwd: nested });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("../docs/selected.md");
      expect(result.stdout).not.toContain("decoy.md");
      expect(result.stdout).toContain(`alignfirst docmap --root ${join(project, "docs")}`);
    },
  );

  it("selects companion docs from nested cwd unless a caller-relative root is given", async () => {
    const { root, home, project, companion } = makeCompanionProject({ docs: "companion" });
    dirs.push(root);
    mkdirSync(join(companion, "docs"), { recursive: true });
    writeFileSync(join(companion, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "local.md"), "---\ntitle: Local\n---\n\n# Local\n");
    const nested = join(project, "src");
    mkdirSync(join(nested, "docs"), { recursive: true });
    writeFileSync(join(nested, "docs", "decoy.md"), "# Decoy\n");
    const selected = await runMain(["docmap"], { cwd: nested, home });
    expect(selected).toMatchObject({ code: 0, stderr: "" });
    expect(selected.stdout).toContain("topic.md");
    expect(selected.stdout).not.toMatch(/local\.md|decoy\.md/);
    const explicit = await runMain(["docmap", "--root", "docs"], { cwd: nested, home });
    expect(explicit).toMatchObject({ code: 0, stderr: "" });
    expect(explicit.stdout).toContain("docs/decoy.md");
    expect(explicit.stdout).not.toMatch(/topic\.md|local\.md/);
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
