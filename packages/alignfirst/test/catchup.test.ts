import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ticket --catchup", () => {
  it("loads top-level Markdown in numeric order, preserving plan summaries and other history", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    const included = [
      "A1-request.md",
      "A2-brainstorming.md",
      "A3-main-plan.summary.md",
      "A9-plan-cli.summary.md",
      "A10-review.md",
      "B1-AAD.summary.md",
      "notes.md",
    ];
    for (const file of [...included].reverse())
      writeFileSync(join(directory, file), `Body: ${file}`);
    for (const file of ["A3-main-plan.md", "A9-plan-cli.md", "evidence.txt"])
      writeFileSync(join(directory, file), "excluded body");
    for (const folder of ["_aldev", "nested.md"]) {
      mkdirSync(join(directory, folder));
      writeFileSync(join(directory, folder, "A1-spec.md"), "excluded nested body");
    }

    const result = await runMain(["ticket", "78", "--catchup"], { cwd });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("- TICKET_DIR: `.plans/78/`");
    expect(result.stdout).toContain("- Entries:\n");
    expect(result.stdout).not.toContain("excluded");
    expect(result.stdout).not.toContain('path=".plans/78/_aldev');
    const paths = [
      ...result.stdout.matchAll(/^<file path="\.plans\/78\/(.+)" modified="[^"]+">$/gm),
    ].map((match) => match[1]);
    expect(paths).toEqual(included);
    for (const file of included) expect(result.stdout).toContain(`Body: ${file}`);
  });

  it("uses the same numeric ordering for ordinary Markdown and JSON listings", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    const ordered = [
      "A1-spec.md",
      "A9-review.md",
      "A10-AAD.summary.md",
      "B2-spec.md",
      "B10-review.md",
    ];
    for (const file of [...ordered].reverse()) writeFileSync(join(directory, file), "history");

    const markdown = await runMain(["ticket", "78"], { cwd });
    const json = await runMain(["ticket", "78", "--json"], { cwd });

    const listed = markdown.stdout.split("- Entries:\n")[1].trimEnd().split("\n");
    expect(listed.map((line) => line.split(" ")[3].slice(1, -1))).toEqual(ordered);
    expect(listed[0]).toMatch(
      /^ {2}- `A1-spec\.md` \(7 B, \d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d\)$/,
    );
    const entries = JSON.parse(json.stdout).entries;
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual(ordered);
    expect(entries[0]).toMatchObject({ name: "A1-spec.md", size: 7 });
    expect(new Date(entries[0].modifiedAt).getTime()).toBeGreaterThan(0);
  });

  it("switches the whole output to the entry list, without printing partial history", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    writeFileSync(join(directory, "A9-spec.md"), "x".repeat(16_000));
    writeFileSync(join(directory, "A10-review.md"), "y".repeat(16_000));

    const result = await runMain(["ticket", "78", "--catchup"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("History too large to print");
    expect(result.stdout).toContain("  - `A9-spec.md` (15.6 KiB, ");
    expect(result.stdout).toContain("  - `A10-review.md` (15.6 KiB, ");
    expect(result.stdout).not.toContain("<file");
    expect(result.stdout.indexOf("A9-spec.md")).toBeLessThan(
      result.stdout.indexOf("A10-review.md"),
    );
    expect(result.stdout).not.toContain("xxx");
    expect(result.stdout).not.toContain("yyy");
  });

  it("counts headers and UTF-8 bytes at the total budget boundary", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    const file = join(directory, "A1-spec.md");
    writeFileSync(file, "é".repeat(10_000));
    const initial = await runMain(["ticket", "78", "--catchup"], { cwd });
    const remaining = 30_720 - Buffer.byteLength(initial.stdout);
    writeFileSync(file, `${"é".repeat(10_000)}${"x".repeat(remaining)}`);

    const atLimit = await runMain(["ticket", "78", "--catchup"], { cwd });
    expect(Buffer.byteLength(atLimit.stdout)).toBe(30_720);
    expect(atLimit.stdout).toContain("ééé");

    writeFileSync(file, `${"é".repeat(10_000)}${"x".repeat(remaining + 1)}`);
    const overLimit = await runMain(["ticket", "78", "--catchup"], { cwd });
    expect(overLimit.stdout).toContain("History too large to print");
    expect(overLimit.stdout).not.toContain("ééé");
  });

  it("omits files over 64 KiB individually while printing other eligible content", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    const oversized = join(directory, "A1-evidence.md");
    writeFileSync(oversized, "x".repeat(65_537));
    writeFileSync(join(directory, "A2-spec.md"), "Small specification");

    const result = await runMain(["ticket", "78", "--catchup"], { cwd });

    expect(result.stdout).toMatch(
      /<file path="\.plans\/78\/A1-evidence\.md" modified="[^"]+">\nContent omitted: over the 64 KiB limit\.\n<\/file>/,
    );
    expect(result.stdout).toContain("  - `A1-evidence.md` (64 KiB, ");
    expect(result.stdout).toContain("Small specification");
    expect(result.stdout).not.toContain("xxx");
    expect(result.stdout).not.toContain("History too large");

    writeFileSync(oversized, "x".repeat(65_536));
    const atLimit = await runMain(["ticket", "78", "--catchup"], { cwd });
    expect(atLimit.stdout).toContain("History too large");
    expect(atLimit.stdout).not.toContain("Content omitted");
  });

  it("restores archived history and infers the current ticket from the branch", async () => {
    const cwd = project();
    configureGit(cwd);
    git(cwd, "init", "--quiet");
    git(cwd, "checkout", "-q", "-b", "78/catchup");
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }),
    );
    const archive = join(cwd, ".plans", "_archives", "78");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "B10-review.md"), "Archived review");
    writeFileSync(join(archive, "B9-spec.md"), "Archived spec");

    const result = await runMain(["ticket", "--catchup"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("restored from _archives");
    expect(result.stdout).toContain("Archived review");
    expect(result.stdout.indexOf("B9-spec.md")).toBeLessThan(
      result.stdout.indexOf("B10-review.md"),
    );
    expect(existsSync(archive)).toBe(false);
  });

  it("reports empty or missing tickets and rejects a fresh side ticket", async () => {
    const cwd = project();
    const result = await runMain(["ticket", "78", "--catchup"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("No Markdown files to load.");
    const side = await runMain(["ticket", "--side", "--catchup"], { cwd });
    expect(side.code).toBe(1);
    expect(side.stderr).toContain("--catchup cannot be combined with --side");
    expect(existsSync(join(cwd, ".plans", "side-1"))).toBe(false);
  });

  it("fails without printing content when a selected file is unreadable", async () => {
    const cwd = project();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    writeFileSync(join(directory, "A1-spec.md"), "Read first");
    symlinkSync(join(directory, "missing"), join(directory, "A2-review.md"));

    const result = await runMain(["ticket", "78", "--catchup"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot load catchup file");
    expect(result.stderr).toContain("A2-review.md");
  });

  it("rejects conflicting flags before creating a ticket", async () => {
    const cwd = project();
    for (const flags of [["--next"], ["--new-cycle"], ["--json"], ["--dry-run"]]) {
      const result = await runMain(["ticket", "78", "--catchup", ...flags], { cwd });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
  });
});

function project(): string {
  const cwd = makeTempDir();
  dirs.push(cwd);
  mkdirSync(join(cwd, ".plans"));
  return cwd;
}
