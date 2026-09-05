import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ticket command", () => {
  it("creates, lists and restores ticket directories", async () => {
    const cwd = makeProject();
    const created = await runMain(["ticket", "78"], { cwd });
    expect(created.stdout).toContain("Directory: .plans/78/ (created)");
    writeFileSync(join(cwd, ".plans", "78", "A1-request.md"), "request");
    expect((await runMain(["ticket", "78", "--next", "spec.md"], { cwd })).stdout).toContain(
      "Next file: .plans/78/A2-spec.md",
    );
    mkdirSync(join(cwd, ".plans", "_archives"));
    mkdirSync(join(cwd, ".plans", "_archives", "99"));
    const restored = await runMain(["ticket", "99"], { cwd });
    expect(restored.stdout).toContain("restored from _archives");
    expect(existsSync(join(cwd, ".plans", "99"))).toBe(true);
  });

  it("computes a new cycle and keeps dry runs read-only", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "78"));
    writeFileSync(join(cwd, ".plans", "78", "A2-spec.md"), "spec");
    const next = await runMain(
      ["ticket", "78", "--next", "notes.txt", "--new-cycle", "--dry-run"],
      { cwd },
    );
    expect(next.stdout).toContain(".plans/78/B1-notes.txt");
    const missing = await runMain(["ticket", "79", "--dry-run"], { cwd });
    expect(missing.stdout).toContain("would be created");
    expect(existsSync(join(cwd, ".plans", "79"))).toBe(false);
  });

  it("computes a dry-run filename from archived entries", async () => {
    const cwd = makeProject();
    const archive = join(cwd, ".plans", "_archives", "99");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "C4-plan.md"), "plan");

    const result = await runMain(["ticket", "99", "--next", "AAD.summary.md", "--dry-run"], {
      cwd,
    });

    expect(result.stdout).toContain("Next file: .plans/99/C5-AAD.summary.md");
    expect(existsSync(join(cwd, ".plans", "99"))).toBe(false);
    expect(existsSync(archive)).toBe(true);
  });

  it("reserves side tickets across active and archived entries, including an EEXIST race", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "_archives", "side-2"), { recursive: true });
    writeFileSync(join(cwd, ".plans", "side-3"), "occupied");
    const result = await runMain(["ticket", "--side", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "side-4", state: "created" });
    expect(existsSync(join(cwd, ".plans", "side-4"))).toBe(true);
  });

  it("accounts for occupied names when previewing a side ticket", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "_archives", "side-2"), { recursive: true });
    writeFileSync(join(cwd, ".plans", "side-3"), "occupied");
    const result = await runMain(["ticket", "--side", "--dry-run", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "side-4", state: "created" });
    expect(existsSync(join(cwd, ".plans", "side-4"))).toBe(false);
  });

  it("deduces the ticket from the branch and emits the JSON contract", async () => {
    const cwd = makeProject();
    git(cwd, "checkout", "-q", "-b", "78/unified-cli");
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }),
    );
    const result = await runMain(["ticket", "--json", "--next", "spec.md"], { cwd });
    expect(JSON.parse(result.stdout)).toEqual({
      id: "78",
      dir: ".plans/78",
      state: "created",
      branch: "78/unified-cli",
      entries: [],
      next: ".plans/78/A1-spec.md",
    });
  });

  it("requires the plans gate and validates configured ids", async () => {
    const cwd = makeProject(false);
    expect((await runMain(["ticket", "78"], { cwd })).stderr).toContain(
      "No .plans/ directory in the current directory.",
    );
    mkdirSync(join(cwd, ".plans"));
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }),
    );
    expect((await runMain(["ticket", "abc"], { cwd })).stderr).toContain("does not match");
    expect((await runMain(["ticket", "side-2"], { cwd })).code).toBe(0);
  });

  it("explains how to enable branch deduction when no id or pattern is given", async () => {
    const cwd = makeProject();
    const result = await runMain(["ticket"], { cwd });
    expect(result.stderr).toContain("No ticket id given. Pass it.");
    expect(result.stderr).toContain("Setting ticketIdPattern");
  });
});

function makeProject(withPlans = true): string {
  const cwd = makeTempDir();
  dirs.push(cwd);
  configureGit(cwd);
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "README.md"), "project");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "init");
  if (withPlans) mkdirSync(join(cwd, ".plans"));
  return cwd;
}
