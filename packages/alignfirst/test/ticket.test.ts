import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { detectTicketFromBranch, nextFilePosition } from "../src/plans/ticket.js";
import { configureGit, git, makeCompanionProject, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ticket command", () => {
  it("creates, lists and restores ticket directories", async () => {
    const cwd = makeProject();
    const created = await runMain(["ticket", "78"], { cwd });
    expect(created.stdout).toContain(".plans/78/");
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(true);
    writeFileSync(join(cwd, ".plans", "78", "A1-request.md"), "request");
    expect((await runMain(["ticket", "78", "--next", "spec.md"], { cwd })).stdout).toContain(
      "A2-spec.md",
    );
    expect(existsSync(join(cwd, ".plans", "78", "A2-spec.md"))).toBe(false);
    mkdirSync(join(cwd, ".plans", "_archives"));
    mkdirSync(join(cwd, ".plans", "_archives", "99"));
    const restored = await runMain(["ticket", "99"], { cwd });
    expect(restored.code).toBe(0);
    expect(existsSync(join(cwd, ".plans", "_archives", "99"))).toBe(false);
    expect(existsSync(join(cwd, ".plans", "99"))).toBe(true);
  });

  it("numbers repeated --next filenames after archived entries without restoring them", async () => {
    const cwd = makeProject();
    const archive = join(cwd, ".plans", "_archives", "99");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "C4-plan.md"), "plan");
    const result = await runMain(
      ["ticket", "99", "--next", "main-plan.md", "--next=plan-api.md", "--dry-run", "--json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      TICKET_DIR: ".plans/99/",
      CYCLE_LETTER: "C",
      FILE_NAMES: ["C5-main-plan.md", "C6-plan-api.md"],
    });
    expect(existsSync(join(cwd, ".plans", "99"))).toBe(false);
    expect(existsSync(archive)).toBe(true);
  });

  it.each<[string, string[], boolean, string | undefined, string]>([
    ["starts an empty ticket at A1", [], false, undefined, "A1"],
    [
      "ignores entries without a prefix",
      ["A1-request.md", "notes.md", "_aligndev/"],
      false,
      undefined,
      "A2",
    ],
    [
      "continues the latest cycle numerically",
      ["A99-plan.md", "B2-spec.md", "B10-plan.md"],
      false,
      undefined,
      "B11",
    ],
    [
      "opens the cycle after the latest",
      ["A99-plan.md", "B2-spec.md", "B10-plan.md"],
      true,
      undefined,
      "C1",
    ],
    [
      "numbers within the selected cycle",
      ["A2-spec.md", "A10-plan.md", "B99-review.md"],
      false,
      "A",
      "A11",
    ],
    ["starts a selected cycle of an empty ticket at 1", [], false, "Z", "Z1"],
    ["starts an unused selected cycle at 1", ["B20-spec.md"], false, "A", "A1"],
  ])("next file position: %s", (_case, entries, newCycle, selectedCycle, expected) => {
    const { cycleLetter, fileNumber } = nextFilePosition(entries, newCycle, selectedCycle);
    expect(`${cycleLetter}${fileNumber}`).toBe(expected);
  });

  it.each([
    ["an invalid cycle letter", ["78", "--cycle", "a", "--next"]],
    ["--cycle without --next", ["--side", "--cycle", "A"]],
    ["--cycle with --new-cycle", ["78", "--cycle", "A", "--next", "--new-cycle"]],
    ["--new-cycle without --next", ["78", "--new-cycle"]],
    [
      "a bare --next inside a repeated --next",
      ["78", "--next", "main-plan.md", "--next", "--json"],
    ],
    ["a path in --next", ["--side", "--next", "../outside.md"]],
    ["a backslash in --next", ["78", "--next", "nested\\file.md"]],
    ["an empty inline --next", ["78", "--next="]],
  ])("rejects %s before creating or reserving a ticket", async (_case, args) => {
    const cwd = makeProject();
    const result = await runMain(["ticket", ...args], { cwd });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(readdirSync(join(cwd, ".plans"))).toEqual([]);
  });

  it("accepts bare --next with cycle and dry-run flags and an explicit ticket after --", async () => {
    const cwd = makeProject();
    const archive = join(cwd, ".plans", "_archives", "78");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "C4-plan.md"), "plan");
    const result = await runMain(
      ["ticket", "--next", "--new-cycle", "--dry-run", "--json", "--", "78"],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "D",
      FILE_NUMBER: 1,
      FILE_PREFIX: "D1",
    });
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
    expect(existsSync(archive)).toBe(true);
  });

  it("previews side-ticket prefixes and creates side tickets with named output", async () => {
    const cwd = makeProject();
    const preview = await runMain(
      ["ticket", "--side", "--cycle", "Z", "--next", "--dry-run", "--json"],
      { cwd },
    );
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({
      TICKET_DIR: ".plans/side-1/",
      CYCLE_LETTER: "Z",
      FILE_NUMBER: 1,
      FILE_PREFIX: "Z1",
    });
    expect(existsSync(join(cwd, ".plans", "side-1"))).toBe(false);
    const created = await runMain(["ticket", "--side", "--next", "request.md", "--json"], {
      cwd,
    });
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      TICKET_DIR: ".plans/side-1/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 1,
      FILE_NAME: "A1-request.md",
    });
    expect(existsSync(join(cwd, ".plans", "side-1"))).toBe(true);
    expect(existsSync(join(cwd, ".plans", "side-1", "A1-request.md"))).toBe(false);
  });

  it("reserves side tickets across active and archived entries, including an EEXIST race", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "_archives", "side-2"), { recursive: true });
    writeFileSync(join(cwd, ".plans", "side-3"), "occupied");
    const result = await runMain(["ticket", "--side", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toMatchObject({ TICKET_ID: "side-4", state: "created" });
    expect(existsSync(join(cwd, ".plans", "side-4"))).toBe(true);
  });

  it("accounts for occupied names when previewing a side ticket", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "_archives", "side-2"), { recursive: true });
    writeFileSync(join(cwd, ".plans", "side-3"), "occupied");
    const result = await runMain(["ticket", "--side", "--dry-run", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toMatchObject({ TICKET_ID: "side-4", state: "created" });
    expect(existsSync(join(cwd, ".plans", "side-4"))).toBe(false);
  });

  it("deduces the ticket from the branch and emits the JSON contract", async () => {
    const cwd = makeProject();
    git(cwd, "checkout", "-q", "-b", "78/unified-cli");
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, conventions: { ticketIdPattern: "^\\d+$" } }),
    );
    const result = await runMain(["ticket", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toEqual({
      TICKET_ID: "78",
      TICKET_DIR: ".plans/78/",
      state: "created",
      branch: "78/unified-cli",
      entries: [],
    });
  });

  it("requires the plans gate and validates configured ids", async () => {
    const cwd = makeProject(false);
    expect(await runMain(["ticket", "78"], { cwd })).toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(join(cwd, ".plans"))).toBe(false);
    expect(await runMain(["ticket", "--help"], { cwd })).toMatchObject({ code: 0, stderr: "" });
    symlinkSync(join(cwd, "missing-clone"), join(cwd, ".plans"));
    expect(await runMain(["ticket", "78"], { cwd })).toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(join(cwd, "missing-clone"))).toBe(false);
    rmSync(join(cwd, ".plans"));
    mkdirSync(join(cwd, ".plans"));
    expect(await runMain(["ticket", "_archives"], { cwd })).toMatchObject({ code: 1, stdout: "" });
    expect(existsSync(join(cwd, ".plans", "_archives"))).toBe(false);
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, conventions: { ticketIdPattern: "^\\d+$" } }),
    );
    expect((await runMain(["ticket", "abc"], { cwd })).code).toBe(0);
    expect((await runMain(["ticket", "side-2"], { cwd })).code).toBe(0);
  });

  it("deduces the id from an existing ticket named by the branch", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "78"));
    mkdirSync(join(cwd, ".plans", "7"));
    git(cwd, "checkout", "--quiet", "-b", "78/unified-cli");
    const result = await runMain(["ticket", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toMatchObject({ TICKET_ID: "78", branch: "78/unified-cli" });
  });

  it("lists existing tickets when the branch names none of them", async () => {
    const cwd = makeProject();
    const activeFile = join(cwd, ".plans", "78", "A1-spec.md");
    const archivedDir = join(cwd, ".plans", "_archives", "side-1");
    const activeDate = new Date("2026-01-02T00:00:00Z");
    const archivedDate = new Date("2026-01-01T00:00:00Z");
    mkdirSync(join(cwd, ".plans", "78"));
    writeFileSync(activeFile, "spec");
    mkdirSync(archivedDir, { recursive: true });
    utimesSync(activeFile, activeDate, activeDate);
    utimesSync(archivedDir, archivedDate, archivedDate);
    git(cwd, "checkout", "--quiet", "-b", "781/other");
    const result = await runMain(["ticket", "--catchup"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("78");
    expect(result.stderr).toContain("side-1");
    expect(result.stderr.indexOf("78")).toBeLessThan(result.stderr.indexOf("side-1"));
    expect(existsSync(join(cwd, ".plans", "781"))).toBe(false);
  });
});

describe("ticket detection from the branch", () => {
  const sharedDirs: string[] = [];
  let cwd: string;

  beforeAll(() => {
    cwd = makeProject(false, sharedDirs);
  });

  afterAll(() => {
    for (const dir of sharedDirs) rmSync(dir, { recursive: true, force: true });
  });

  it.each<[string, string | undefined, string | undefined, string | undefined]>([
    ["side-8/slug", "^\\d+$", "{TICKET_ID}/{slug-1-3-words}", "side-8"],
    ["side-8/slug", undefined, undefined, "side-8"],
    ["78/unified-cli", "^\\d+$", undefined, "78"],
    ["feature/78-fix", "^\\d+$", "feature/{TICKET_ID}-{slug}", "78"],
    ["feature/78-fix-more", "^\\d+$", "feature/{TICKET_ID}-{slug}", "78"],
    ["feature/side-8-fix", "^\\d+$", "feature/{TICKET_ID}-{slug}", "side-8"],
    ["feature/ABC-78-fix-more", "^(ABC|XYZ)-\\d+$", "feature/{TICKET_ID}-{slug}", "ABC-78"],
    ["hotfix/typo", "^\\d+$", "{TICKET_ID}/{slug-1-3-words}", undefined],
  ])("detects in %s with pattern %s and template %s: %s", (branch, pattern, template, id) => {
    git(cwd, "checkout", "-q", "-B", branch);
    expect(detectTicketFromBranch(cwd, pattern, template)).toEqual(
      id === undefined ? { kind: "noMatch", branch } : { kind: "detected", id, branch },
    );
  });
});

describe("ticket command with a companion .plans", () => {
  it("prints an absolute TICKET_DIR in the text, JSON and --next forms", async () => {
    const { home, project, plans } = companionPlans();
    const ticketDir = `${join(plans, "78")}/`;
    const text = await runMain(["ticket", "78"], { cwd: project, home });
    expect(text.stdout).toContain(ticketDir);
    expect(existsSync(join(plans, "78"))).toBe(true);
    expect(existsSync(join(project, ".plans"))).toBe(false);
    const json = await runMain(["ticket", "78", "--json"], { cwd: project, home });
    expect(JSON.parse(json.stdout)).toMatchObject({ TICKET_DIR: ticketDir, state: "existing" });
    const next = await runMain(["ticket", "78", "--next", "spec.md"], { cwd: project, home });
    expect(next.stdout).toContain(ticketDir);
    expect(next.stdout).toContain("A1-spec.md");
  });

  it("reserves side tickets in the companion", async () => {
    const { home, project, plans } = companionPlans();
    mkdirSync(join(plans, "_archives", "side-1"), { recursive: true });
    const result = await runMain(["ticket", "--side", "--json"], { cwd: project, home });
    expect(JSON.parse(result.stdout)).toMatchObject({
      TICKET_ID: "side-2",
      TICKET_DIR: `${join(plans, "side-2")}/`,
    });
    expect(existsSync(join(plans, "side-2"))).toBe(true);
  });

  it("names the companion location when .plans is missing", async () => {
    const { home, project, plans } = companionPlans();
    rmSync(plans, { recursive: true });
    const result = await runMain(["ticket", "78"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(plans);
    expect(existsSync(plans)).toBe(false);
  });
});

describe("ticket command with a separate session tree", () => {
  it.each([undefined, "work"])(
    "restores the ticket's archived session directory with profile %s",
    async (profile) => {
      const { root, home, project, companion } = makeCompanionProject(
        {
          ".plans": "project",
          _aligndev: "companion",
        },
        profile,
      );
      dirs.push(root);
      const sessions = join(companion, ".plans");
      mkdirSync(join(project, ".plans", "_archives", "78"), { recursive: true });
      mkdirSync(join(sessions, "_archives", "78", "_aligndev"), { recursive: true });

      const result = await runMain(["ticket", "78", "--json"], { cwd: project, home });

      expect(JSON.parse(result.stdout)).toMatchObject({ state: "restored" });
      expect(existsSync(join(project, ".plans", "78"))).toBe(true);
      expect(existsSync(join(sessions, "78", "_aligndev"))).toBe(true);
      expect(existsSync(join(sessions, "_archives", "78"))).toBe(false);
      expect(existsSync(join(project, ".plans", "78", "_aligndev"))).toBe(false);
    },
  );

  it("leaves the session tree alone on a dry run", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      ".plans": "project",
      _aligndev: "companion",
    });
    dirs.push(root);
    const archived = join(companion, ".plans", "_archives", "78");
    mkdirSync(join(project, ".plans"), { recursive: true });
    mkdirSync(archived, { recursive: true });

    await runMain(["ticket", "78", "--dry-run"], { cwd: project, home });

    expect(existsSync(archived)).toBe(true);
  });
});

interface CompanionPlans {
  home: string;
  project: string;
  plans: string;
}

function companionPlans(): CompanionPlans {
  const { root, home, project, companion } = makeCompanionProject({ ".plans": "companion" });
  dirs.push(root);
  const plans = join(companion, ".plans");
  mkdirSync(plans, { recursive: true });
  return { home, project, plans };
}

function makeProject(withPlans = true, owner = dirs): string {
  const cwd = makeTempDir();
  owner.push(cwd);
  configureGit(cwd);
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "README.md"), "project");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "init");
  if (withPlans) mkdirSync(join(cwd, ".plans"));
  return cwd;
}
