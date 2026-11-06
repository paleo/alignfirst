import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureGit,
  git,
  initRepository,
  makeCompanionProject,
  makeTempDir,
  runMain,
} from "./helpers.js";

const dirs: string[] = [];
const devServer = {
  ports: { first: 28100, last: 28199, declare: ["app"] },
  servers: [
    {
      kind: "spawn",
      name: "app",
      exec: { run: ["false"] },
      ready: { log: "ready" },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context command", () => {
  it("reads project context without including assistant-only instructions", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    mkdirSync(join(cwd, ".alignfirst-instructions"));
    writeFileSync(
      join(cwd, ".alignfirst-instructions", "context.md"),
      "\nRun the tests with `npm test`.\n\n",
    );
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, devServer, assistantInstructionsFile: "assistant.md" }),
    );
    writeFileSync(join(cwd, "assistant.md"), "Assistant-only instructions\n");
    const result = await runMain(["context"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Run the tests with `npm test`.");
    expect(result.stdout).not.toContain("Assistant-only instructions");
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
    writeFileSync(
      join(companion, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, workspace: {} }),
    );
    writeFileSync(
      join(project, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, devServer }),
    );
    const result = await runMain(["context"], { cwd: project, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Companion instructions.");
    expect(result.stdout).toContain(`alignfirst docmap --root ${join(companion, "docs")}`);
    expect(result.stdout).toContain("topic.md");
  });
});

describe("assistant-instructions command", () => {
  it("keeps the legacy command as a warning alias with identical output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = temp();
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, assistantInstructionsFile: "workflow.md" }),
    );
    writeFileSync(join(cwd, "workflow.md"), "Use the project workflow.\n");
    const canonical = await runMain(["assistant-instructions"], { cwd });
    expect(canonical).toMatchObject({ code: 0, stderr: "" });
    expect(canonical.stdout).toContain("Use the project workflow.");
    expect(warn).not.toHaveBeenCalled();
    const legacy = await runMain(["developer-instructions"], { cwd });
    expect(legacy).toEqual(canonical);
    expect(warn).toHaveBeenCalled();
  });

  it("includes configured conventions without discovering filenames or agent context", async () => {
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
    const result = await runMain(["assistant-instructions"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("^TASK-[0-9]+$");
    expect(result.stdout).toContain("{TICKET_ID}/{slug}");
    expect(result.stdout).toContain("type: [TICKET_ID] summary");
    expect(result.stdout).toContain(".plans");
    expect(result.stdout).not.toMatch(/Ignored|Agent-only/);
  });

  it("preserves custom content and reports its absolute source", async () => {
    const cwd = temp();
    const path = join(cwd, "handbook", "workflow.md");
    mkdirSync(join(cwd, "handbook"));
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        assistantInstructionsFile: "handbook/workflow.md",
        devServer,
      }),
    );
    const content = "\n# Workflow\r\n\nSee [setup](./setup.md). {{LITERAL}} $HOME\n  ";
    writeFileSync(path, content);
    const result = await runMain(["assistant-instructions"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(content);
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
          assistantInstructionsFile: "guide.md",
        }),
      );
      if (kind === "directory") mkdirSync(path);
      const result = await runMain(["assistant-instructions"], { cwd });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(path);
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
        assistantInstructionsFile: "main.md",
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
        assistantInstructionsFile: "branch.md",
        devServer,
      }),
    );
    writeFileSync(join(linked, "branch.md"), "Branch instructions\n");
    const nested = join(linked, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const result = await runMain(["assistant-instructions"], { cwd: nested });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(join(linked, "branch.md"));
    expect(result.stdout).toContain("Branch instructions");
    expect(result.stdout).not.toContain("Main instructions");
    expect(result.stdout).toContain("alignfirst dev status");
    expect((await runMain(["assistant-instructions"], { cwd: main })).stdout).toContain(
      "Main instructions",
    );
  });

  it("uses the logical companion override independently of the selected configuration", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      alignfirst: "project",
      assistantInstructionsFile: "companion",
    });
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(
      join(project, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        assistantInstructionsFile: "workflow.md",
        devServer,
      }),
    );
    writeFileSync(
      join(companion, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, workspace: {} }),
    );
    writeFileSync(join(project, "workflow.md"), "Wrong project guide\n");
    writeFileSync(join(companion, "workflow.md"), "Selected companion guide\n");
    const result = await runMain(["assistant-instructions"], { cwd: project, home });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(join(companion, "workflow.md"));
    expect(result.stdout).toContain("Selected companion guide");
    expect(result.stdout).not.toContain("Wrong project guide");
    expect(result.stdout).toContain("alignfirst dev status");
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-context-");
  dirs.push(dir);
  return dir;
}
