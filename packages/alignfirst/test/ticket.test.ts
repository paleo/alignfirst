import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeCompanionProject, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ticket command", () => {
  it("creates, lists and restores ticket directories", async () => {
    const cwd = makeProject();
    const created = await runMain(["ticket", "78"], { cwd });
    expect(created.stdout).toContain("- TICKET_DIR: `.plans/78/` (created)");
    writeFileSync(join(cwd, ".plans", "78", "A1-request.md"), "request");
    expect((await runMain(["ticket", "78", "--next", "spec.md"], { cwd })).stdout).toBe(
      "- TICKET_DIR: `.plans/78/`\n- CYCLE_LETTER: `A`\n- FILE_NUMBER: `2`\n- FILE_NAME: `A2-spec.md`\n",
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
    expect(next.stdout).toBe(
      "- TICKET_DIR: `.plans/78/`\n- CYCLE_LETTER: `B`\n- FILE_NUMBER: `1`\n- FILE_NAME: `B1-notes.txt`\n",
    );
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

    expect(result.stdout).toBe(
      "- TICKET_DIR: `.plans/99/`\n- CYCLE_LETTER: `C`\n- FILE_NUMBER: `5`\n- FILE_NAME: `C5-AAD.summary.md`\n",
    );
    expect(existsSync(join(cwd, ".plans", "99"))).toBe(false);
    expect(existsSync(archive)).toBe(true);
  });

  it("prints prefixes without reserving numbers and advances after a file is written", async () => {
    const cwd = makeProject();
    const first = await runMain(["ticket", "78", "--next"], { cwd });
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toBe(
      "- TICKET_DIR: `.plans/78/`\n- CYCLE_LETTER: `A`\n- FILE_NUMBER: `1`\n- FILE_PREFIX: `A1`\n",
    );
    expect((await runMain(["ticket", "78", "--next"], { cwd })).stdout).toBe(first.stdout);
    expect((await runMain(["ticket", "78", "--next", "spec.md"], { cwd })).stdout).toContain(
      "- FILE_NAME: `A1-spec.md`",
    );
    writeFileSync(join(cwd, ".plans", "78", "A1-spec.md"), "spec");
    expect((await runMain(["ticket", "78", "--next"], { cwd })).stdout).toContain(
      "- FILE_PREFIX: `A2`",
    );
  });

  it("emits the same compact information in JSON for either next form", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "78"));
    writeFileSync(join(cwd, ".plans", "78", "A1-request.md"), "request");
    const prefix = await runMain(["ticket", "78", "--next", "--json"], { cwd });
    expect(prefix.code).toBe(0);
    expect(JSON.parse(prefix.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 2,
      FILE_PREFIX: "A2",
    });
    const filename = await runMain(["ticket", "78", "--next", "spec.md", "--json"], { cwd });
    expect(filename.code).toBe(0);
    expect(JSON.parse(filename.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 2,
      FILE_NAME: "A2-spec.md",
    });
  });

  it("reports numeric ordering and the next cycle consistently in both formats", async () => {
    const cwd = makeProject();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    for (const filename of ["A99-plan.md", "B2-spec.md", "B10-plan.md"]) {
      writeFileSync(join(directory, filename), "work");
    }
    for (const newCycle of [false, true]) {
      const cycle = newCycle ? "C" : "B";
      const number = newCycle ? 1 : 11;
      const flags = newCycle ? ["--new-cycle"] : [];
      for (const filename of [undefined, "review.md"]) {
        const args = [
          "ticket",
          "78",
          "--next",
          ...(filename === undefined ? [] : [filename]),
          ...flags,
        ];
        const markdown = await runMain(args, { cwd });
        const json = await runMain([...args, "--json"], { cwd });
        expect(markdown.code).toBe(0);
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual({
          TICKET_DIR: ".plans/78/",
          CYCLE_LETTER: cycle,
          FILE_NUMBER: number,
          ...(filename === undefined
            ? { FILE_PREFIX: `${cycle}${number}` }
            : { FILE_NAME: `${cycle}${number}-review.md` }),
        });
        const markdownFields = Object.fromEntries(
          markdown.stdout
            .trimEnd()
            .split("\n")
            .map((line) => {
              const match = /^- ([A-Z_]+): `(.+)`$/.exec(line);
              if (!match) throw new Error(`Unexpected output line: ${line}`);
              return [match[1], match[1] === "FILE_NUMBER" ? Number(match[2]) : match[2]];
            }),
        );
        expect(markdownFields).toEqual(JSON.parse(json.stdout));
      }
    }
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

  it("supports inline filenames and rejects explicitly empty filenames", async () => {
    const cwd = makeProject();
    const invalid = await runMain(["ticket", "78", "--next="], { cwd });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("--next must be a non-empty single path segment.");
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
    const result = await runMain(["ticket", "78", "--next=spec.md"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "- TICKET_DIR: `.plans/78/`\n- CYCLE_LETTER: `A`\n- FILE_NUMBER: `1`\n- FILE_NAME: `A1-spec.md`\n",
    );
  });

  it("numbers a batch of filenames in order when --next repeats", async () => {
    const cwd = makeProject();
    const directory = join(cwd, ".plans", "78");
    mkdirSync(directory);
    writeFileSync(join(directory, "A1-spec.md"), "spec");
    const batch = ["--next", "main-plan.md", "--next=plan-api.md", "--next", "plan-ui.md"];
    const markdown = await runMain(["ticket", "78", ...batch], { cwd });
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toBe(
      [
        "- TICKET_DIR: `.plans/78/`",
        "- CYCLE_LETTER: `A`",
        "- FILE_NAMES:",
        "  - `A2-main-plan.md`",
        "  - `A3-plan-api.md`",
        "  - `A4-plan-ui.md`",
        "",
      ].join("\n"),
    );
    const json = await runMain(["ticket", "78", ...batch, "--json", "--new-cycle"], { cwd });
    expect(JSON.parse(json.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "B",
      FILE_NAMES: ["B1-main-plan.md", "B2-plan-api.md", "B3-plan-ui.md"],
    });
  });

  it("rejects a bare --next inside a repeated --next", async () => {
    const cwd = makeProject();
    for (const args of [
      ["ticket", "78", "--next", "--next", "plan-api.md"],
      ["ticket", "78", "--next", "main-plan.md", "--next", "--json"],
    ]) {
      const result = await runMain(args, { cwd });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("A repeated --next requires a filename on each occurrence.");
    }
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
  });

  it("keeps argument validation for bare --next", async () => {
    const cwd = makeProject();
    for (const args of [
      ["ticket", "78", "--next", "--unknown"],
      ["ticket", "78", "--new-cycle"],
      ["ticket", "78", "--next", "spec.md", "extra"],
      ["ticket", "78", "--side", "--next"],
    ]) {
      expect((await runMain(args, { cwd })).code, args.join(" ")).toBe(1);
    }
    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
  });

  it("previews side-ticket prefixes and creates side tickets with named output", async () => {
    const cwd = makeProject();
    const preview = await runMain(["ticket", "--side", "--next", "--dry-run", "--json"], {
      cwd,
    });
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({
      TICKET_DIR: ".plans/side-1/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 1,
      FILE_PREFIX: "A1",
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

  it("rejects unsafe --next filenames before creating the ticket", async () => {
    const cwd = makeProject();

    for (const filename of ["", ".", "..", "../outside.md", "nested/file.md", "nested\\file.md"]) {
      const result = await runMain(["ticket", "78", "--next", filename], { cwd });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--next must be a non-empty single path segment.");
    }

    expect(existsSync(join(cwd, ".plans", "78"))).toBe(false);
  });

  it("validates --next before reserving a side ticket", async () => {
    const cwd = makeProject();
    const invalid = await runMain(["ticket", "--side", "--next", "../outside.md"], { cwd });

    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("--next must be a non-empty single path segment.");
    expect(existsSync(join(cwd, ".plans", "side-1"))).toBe(false);

    const created = await runMain(["ticket", "--side", "--json"], { cwd });
    expect(JSON.parse(created.stdout)).toMatchObject({ TICKET_ID: "side-1" });
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
      join(cwd, ".alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        ticketIdPattern: "^\\d+$",
        git: { branchNameTemplate: "{TICKET_ID}/{slug-1-3-words}" },
      }),
    );
    const result = await runMain(["ticket", "--json"], { cwd });
    expect(JSON.parse(result.stdout)).toEqual({
      TICKET_ID: "78",
      TICKET_DIR: ".plans/78/",
      state: "created",
      branch: "78/unified-cli",
      entries: [],
    });
    const next = await runMain(["ticket", "--json", "--next", "spec.md"], { cwd });
    expect(JSON.parse(next.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 1,
      FILE_NAME: "A1-spec.md",
    });
    const prefix = await runMain(["ticket", "--json", "--next"], { cwd });
    expect(JSON.parse(prefix.stdout)).toEqual({
      TICKET_DIR: ".plans/78/",
      CYCLE_LETTER: "A",
      FILE_NUMBER: 1,
      FILE_PREFIX: "A1",
    });
  });

  it("detects side tickets before patterns and follows branch templates", async () => {
    const cwd = makeProject();
    const configPath = join(cwd, ".alignfirst.json");
    git(cwd, "checkout", "-q", "-b", "side-8/slug");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        ticketIdPattern: "^\\d+$",
        git: { branchNameTemplate: "{TICKET_ID}/{slug-1-3-words}" },
      }),
    );
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "side-8", branch: "side-8/slug" });

    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }));
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "side-8" });
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1 }));
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "side-8" });

    git(cwd, "checkout", "-q", "-b", "feature/78-fix");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        ticketIdPattern: "^\\d+$",
        git: { branchNameTemplate: "feature/{TICKET_ID}-{slug}" },
      }),
    );
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "78", branch: "feature/78-fix" });

    git(cwd, "checkout", "-q", "-b", "hotfix/typo");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        ticketIdPattern: "^\\d+$",
        git: { branchNameTemplate: "{TICKET_ID}/{slug-1-3-words}" },
      }),
    );
    const noMatch = await runMain(["ticket", "--dry-run"], { cwd });
    expect(noMatch.code).toBe(1);
    expect(noMatch.stderr).toContain(
      'branch "hotfix/typo" with pattern "^\\d+$" and template "{TICKET_ID}/{slug-1-3-words}"',
    );
  });

  it("uses the ticket grammar to disambiguate template placeholders", async () => {
    const cwd = makeProject();
    const configPath = join(cwd, ".alignfirst.json");
    const writeConfig = (ticketIdPattern: string) =>
      writeFileSync(
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          ticketIdPattern,
          git: { branchNameTemplate: "feature/{TICKET_ID}-{slug}" },
        }),
      );

    writeConfig("^\\d+$");
    git(cwd, "checkout", "-q", "-b", "feature/78-fix-more");
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "78" });

    git(cwd, "checkout", "-q", "-b", "feature/side-8-fix");
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "side-8" });

    writeConfig("^(ABC|XYZ)-\\d+$");
    git(cwd, "checkout", "-q", "-b", "feature/ABC-78-fix-more");
    expect(
      JSON.parse((await runMain(["ticket", "--json", "--dry-run"], { cwd })).stdout),
    ).toMatchObject({ TICKET_ID: "ABC-78" });
  });

  it("requires the plans gate and validates configured ids", async () => {
    const cwd = makeProject(false);
    expect((await runMain(["ticket", "78"], { cwd })).stderr).toContain(
      "No .plans/ directory in the current directory.",
    );
    expect(await runMain(["ticket", "--help"], { cwd })).toMatchObject({ code: 0, stderr: "" });
    symlinkSync(join(cwd, "missing-clone"), join(cwd, ".plans"));
    expect((await runMain(["ticket", "78"], { cwd })).stderr).toContain(
      "The .plans symlink is broken.",
    );
    rmSync(join(cwd, ".plans"));
    mkdirSync(join(cwd, ".plans"));
    expect((await runMain(["ticket", "_archives"], { cwd })).stderr).toContain(
      "Invalid ticket id: _archives",
    );
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }),
    );
    expect((await runMain(["ticket", "abc"], { cwd })).code).toBe(0);
    expect((await runMain(["ticket", "side-2"], { cwd })).code).toBe(0);
  });

  it("asks for the id when none is given and no pattern is configured", async () => {
    const cwd = makeProject();
    const result = await runMain(["ticket"], { cwd });
    expect(result.stderr).toBe(
      "No ticket id given. Pass a ticket id, or --side for a new side ticket.\n",
    );
  });

  it("deduces the id from an existing ticket named by the branch", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans", "78"));
    mkdirSync(join(cwd, ".plans", "7"));
    git(cwd, "checkout", "--quiet", "-b", "78/unified-cli");
    const result = await runMain(["ticket"], { cwd });
    expect(result.stdout).toContain("- TICKET_ID: `78` (deduced from branch `78/unified-cli`)");
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
    expect(result.stderr).toMatch(
      /^No ticket id given\. Existing tickets:\n {2}78 {6}\d{4}-\S+\n {2}side-1 {2}\d{4}-\S+ \(archived\)\nPass a ticket id\.\n$/u,
    );
  });
});

describe("ticket command with a companion .plans", () => {
  it("prints an absolute TICKET_DIR in the text, JSON and --next forms", async () => {
    const { home, project, plans } = companionPlans();
    const ticketDir = `${join(plans, "78")}/`;
    const text = await runMain(["ticket", "78"], { cwd: project, home });
    expect(text.stdout).toContain(`- TICKET_DIR: \`${ticketDir}\` (created)`);
    expect(existsSync(join(plans, "78"))).toBe(true);
    expect(existsSync(join(project, ".plans"))).toBe(false);
    const json = await runMain(["ticket", "78", "--json"], { cwd: project, home });
    expect(JSON.parse(json.stdout)).toMatchObject({ TICKET_DIR: ticketDir, state: "existing" });
    const next = await runMain(["ticket", "78", "--next", "spec.md"], { cwd: project, home });
    expect(next.stdout).toContain(`- TICKET_DIR: \`${ticketDir}\`\n`);
    expect(next.stdout).toContain("- FILE_NAME: `A1-spec.md`");
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
    expect(result.stderr).toBe(
      `No .plans/ directory at ${plans} (companion).\nLocal work files:  mkdir -p ${plans}\nTeam work files:   alignfirst plans setup <clone-dir>\n`,
    );
  });
});

interface CompanionPlans {
  home: string;
  project: string;
  plans: string;
}

function companionPlans(): CompanionPlans {
  const { root, home, project, companion } = makeCompanionProject({ ".plans": true });
  dirs.push(root);
  const plans = join(companion, ".plans");
  mkdirSync(plans, { recursive: true });
  return { home, project, plans };
}

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
