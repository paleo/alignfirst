import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configureGit,
  git,
  initRepository,
  makeCompanionProject,
  makeTempDir,
  runMain,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context command", () => {
  it("prints the conventions, the docmap sections, then the protocols section", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    const result = await runMain(["context"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("# Project Conventions\n\nTicket IDs:")).toBe(true);
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n# Docmap Usage\n\ndocmap — browse",
    );
    expect(result.stdout).toContain("`docs/topic.md` — Topic\n\n# AlignFirst Protocols\n\n");
    expect(result.stdout).toContain("run `alignfirst guide <protocol>` and follow it");
    expect(result.stdout).toContain("Catch up (`alcatchup`) — run `alignfirst ticket --catchup`");
    expect(result.stdout).not.toContain("{{");
  });

  it("skips the docmap sections without a docs directory", async () => {
    const result = await runMain(["context"], { cwd: temp() });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Docmap");
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n# AlignFirst Protocols\n\n",
    );
  });

  it("prints the context instructions after the conventions", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    mkdirSync(join(cwd, ".alignfirst-instructions"));
    writeFileSync(
      join(cwd, ".alignfirst-instructions", "context.md"),
      "\nRun the tests with `npm test`.\n\n",
    );
    const result = await runMain(["context"], { cwd });
    expect(result.stdout).toContain(
      "ask before default-branch operations.\n\n# Project Instructions\n\nRun the tests with `npm test`.\n\n# Docmap Usage\n\n",
    );
  });

  it("reads the instructions and the docmap from the companion", async () => {
    const { root, home, project, companion } = makeCompanionProject({});
    dirs.push(root);
    mkdirSync(join(companion, "docs"), { recursive: true });
    writeFileSync(join(companion, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    mkdirSync(join(companion, ".alignfirst-instructions"));
    writeFileSync(
      join(companion, ".alignfirst-instructions", "context.md"),
      "Companion instructions.\n",
    );
    const result = await runMain(["context"], { cwd: project, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Project Instructions\n\nCompanion instructions.\n");
    expect(result.stdout).toContain(`alignfirst docmap --root ${join(companion, "docs")}`);
    expect(result.stdout).toContain("topic.md` — Topic");
  });

  it("prints the default conventions and the protocols in a repository without AlignFirst files", async () => {
    const root = temp();
    configureGit(root);
    const cwd = join(root, "project");
    initRepository(cwd);
    const result = await runMain(["context"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(
      new RegExp(
        "^# Project Conventions\n\n" +
          "Ticket IDs: no configured format; .+\n" +
          "Default branch: unresolved; ask before default-branch operations.\n\n" +
          "# AlignFirst Protocols\n\n",
      ),
    );
  });

  it("prints the default conventions outside git, with local work files", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, ".plans"));
    const result = await runMain(["context"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\nWork files: use `.plans`.\n",
    );
    expect(result.stdout).toContain("# AlignFirst Protocols");
  });

  it.each(["tracked", "differentTarget"])(
    "prints only the first-line Work files diagnostic for %s plans",
    async (kind) => {
      const { root, home, project } = makeCompanionProject({ ".plans": "project" });
      dirs.push(root);
      mkdirSync(join(project, ".plans"));
      let cwd = project;
      if (kind === "tracked") {
        writeFileSync(join(project, ".plans", "note.md"), "tracked\n");
        git(project, "add", ".plans");
      } else {
        cwd = join(root, "linked");
        git(project, "worktree", "add", "--quiet", "-b", "ticket", cwd);
        mkdirSync(join(cwd, ".plans"));
      }
      const check = await runMain(["plans", "check"], { cwd, home });
      expect(check.code).toBe(1);
      const result = await runMain(["context"], { cwd, home });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout.split("\n").filter((line) => line.startsWith("Work files:"))).toEqual([
        `Work files: ${check.stderr.trim().split("\n")[0]}`,
      ]);
      expect(result.stdout).not.toContain("git rm -r --cached");
      expect(result.stdout).toContain("# AlignFirst Protocols");
    },
  );

  it("renders the npx command form", async () => {
    const result = await runMain(["context"], {
      cwd: temp(),
      env: {
        npm_config_user_agent: "npm/10.0.0 node/v22.0.0",
        npm_command: "exec",
        npm_lifecycle_event: "npx",
      },
    });
    expect(result.stdout).toContain("run `npx -y alignfirst guide <protocol>` and follow it");
  });
});

describe("developer-instructions command", () => {
  it("shares conventions without discovering filenames or printing agent context and guides", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    mkdirSync(join(cwd, ".plans"));
    mkdirSync(join(cwd, ".alignfirst-instructions"));
    writeFileSync(join(cwd, "DEVELOPERS.md"), "Ignored developer file\n");
    writeFileSync(join(cwd, "README.md"), "Ignored readme\n");
    writeFileSync(join(cwd, ".alignfirst-instructions", "context.md"), "Agent-only context\n");
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        conventions: {
          ticketIdPattern: "^TASK-[0-9]+$",
          git: {
            branchNameTemplate: "{TICKET_ID}/{slug}",
            commit: { style: "conventionalCommit", ticketReference: "bracketed" },
          },
        },
      }),
    );
    const result = await runMain(["developer-instructions"], { cwd });
    const context = await runMain(["context"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(context.stdout.split("\n# Project Instructions")[0]);
    expect(result.stdout).toContain("Ticket IDs: `^TASK-[0-9]+$`");
    expect(result.stdout).toContain("Branch names: `{TICKET_ID}/{slug}`");
    expect(result.stdout).toContain("`type: [TICKET_ID] summary`");
    expect(result.stdout).toContain("Work files: use `.plans`");
    expect(result.stdout).not.toMatch(
      /Ignored|Agent-only|Docmap|Protocols|# Developer Instructions/,
    );
  });

  it("preserves custom content and reports its absolute source", async () => {
    const cwd = temp();
    const path = join(cwd, "handbook", "workflow.md");
    mkdirSync(join(cwd, "handbook"));
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        developerInstructions: "handbook/workflow.md",
      }),
    );
    const content = "\n# Workflow\r\n\nSee [setup](./setup.md). {{LITERAL}} $HOME\n  ";
    writeFileSync(path, content);
    const result = await runMain(["developer-instructions"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Source: ${path}\n\n${content}`);
    expect(result.stdout.endsWith(content)).toBe(true);
  });

  it.each(["missing", "directory"])(
    "fails before output for a configured %s file",
    async (kind) => {
      const cwd = temp();
      const path = join(cwd, "guide.md");
      writeFileSync(
        join(cwd, "alignfirst.json"),
        JSON.stringify({
          schemaVersion: 1,
          developerInstructions: "guide.md",
        }),
      );
      if (kind === "directory") mkdirSync(path);
      const result = await runMain(["developer-instructions"], { cwd });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Cannot read ${path}:`);
      if (kind === "missing") expect(existsSync(path)).toBe(false);
    },
  );

  it("uses linked-branch instructions and configuration from nested cwd, not main", async () => {
    const root = temp();
    configureGit(root);
    const main = join(root, "main");
    initRepository(main);
    writeFileSync(
      join(main, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        developerInstructions: "main.md",
      }),
    );
    writeFileSync(join(main, "main.md"), "Main instructions\n");
    git(main, "add", ".");
    git(main, "commit", "--quiet", "-m", "instructions");
    const linked = join(root, "linked");
    git(main, "worktree", "add", "--quiet", "-b", "task", linked);
    writeFileSync(
      join(linked, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        developerInstructions: "branch.md",
      }),
    );
    writeFileSync(join(linked, "branch.md"), "Branch instructions\n");
    const nested = join(linked, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const result = await runMain(["developer-instructions"], { cwd: nested });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Source: ${join(linked, "branch.md")}\n\nBranch instructions`);
    expect(result.stdout).not.toContain("Main instructions");
    expect((await runMain(["developer-instructions"], { cwd: main })).stdout).toContain(
      "Main instructions",
    );
  });

  it("uses the logical companion override independently of the selected configuration", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      alignfirst: "project",
      developerInstructions: "companion",
    });
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(
      join(project, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        developerInstructions: "workflow.md",
      }),
    );
    writeFileSync(join(project, "workflow.md"), "Wrong project guide\n");
    writeFileSync(join(companion, "workflow.md"), "Selected companion guide\n");
    const result = await runMain(["developer-instructions"], { cwd: project, home });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      `Source: ${join(companion, "workflow.md")}\n\nSelected companion guide`,
    );
    expect(result.stdout).not.toContain("Wrong project guide");
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-context-");
  dirs.push(dir);
  return dir;
}
