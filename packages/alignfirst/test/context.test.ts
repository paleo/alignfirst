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
const workspacePointer =
  "For worktree preparation and lifecycle operations, see `alignfirst workspace --guide`.";
const configuredWorkspace =
  "This project uses AlignFirst **workspaces**: Git worktrees with project-specific preparation. " +
  "Before managing workspaces or worktrees, run `alignfirst workspace --guide` and follow it.";
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

describe.each(["context", "assistant-instructions"])("%s workspace guidance", (command) => {
  it.each([
    { name: "absent", config: undefined, configured: false, hasDevServer: false },
    {
      name: "conventions-only",
      config: { schemaVersion: 1, conventions: { ticketIdPattern: "^TASK-\\d+$" } },
      configured: false,
      hasDevServer: false,
    },
    {
      name: "workspace-only",
      config: { schemaVersion: 1, workspace: {} },
      configured: true,
      hasDevServer: false,
    },
    {
      name: "devServer-only",
      config: { schemaVersion: 1, devServer },
      configured: true,
      hasDevServer: true,
    },
  ])("uses $name configuration without inventing capabilities", async (settings) => {
    const cwd = temp();
    if (settings.config !== undefined)
      writeFileSync(join(cwd, "alignfirst.json"), JSON.stringify(settings.config));
    const result = await runMain([command], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      `# Workspace\n\n${settings.configured ? configuredWorkspace : workspacePointer}\n`,
    );
    if (settings.hasDevServer) {
      expect(result.stdout).toContain(
        "# Development Server\n\n" +
          "Use the project's AlignFirst commands to manage the development environment:\n\n" +
          "```bash\n" +
          "alignfirst dev up     # start in the background\n" +
          "alignfirst dev status # inspect its status\n" +
          "alignfirst dev down   # stop it\n" +
          "```\n",
      );
    } else {
      expect(result.stdout).not.toContain("# Development Server");
      expect(result.stdout).not.toMatch(/alignfirst dev (up|status|down)/);
    }
  });
});

describe("context command", () => {
  it("prints conventions, workspace guidance, docmap guidance and listing, then protocols", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "topic.md"), "---\ntitle: Topic\n---\n\n# Topic\n");
    const result = await runMain(["context"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("# Project Conventions\n\nTicket IDs:")).toBe(true);
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n" +
        `# Workspace\n\n${workspacePointer}\n\n` +
        "# Docmap Usage\n\nBefore working on a task, read the documents relevant to it.\n\n" +
        "docmap — browse",
    );
    expect(result.stdout).toContain("Commands:\n\n```bash\n");
    expect(result.stdout).toContain("# search documents (prefer browsing the documentation map)");
    expect(result.stdout).not.toMatch(/^alignfirst docmap\s+#/m);
    for (const args of [
      "dir-a",
      "docs/dir-a/doc-1.md",
      "docs/dir-a/doc-1.md docs/doc-2.md dir-b",
      "--recursive",
      '--search "term1 term2"',
    ])
      expect(result.stdout).toContain(`alignfirst docmap ${args}`);
    expect(result.stdout).toContain(
      "Before writing a new document or editing an existing one, run `alignfirst docmap --guide` and follow its rules.",
    );
    expect(result.stdout).toContain("`docs/topic.md` — Topic\n\n# AlignFirst Protocols\n\n");
    const standalone = await runMain(["docmap"], { cwd });
    expect(standalone).toMatchObject({ code: 0, stderr: "" });
    expect(standalone.stdout).toMatch(/^alignfirst docmap\s+# list root documents$/m);
    expect(standalone.stdout).toContain("`docs/topic.md` — Topic");
    expect(result.stdout).toContain("run `alignfirst guide <protocol>` and follow it");
    expect(result.stdout).toContain("Catch up (`alcatchup`) — run `alignfirst ticket --catchup`");
    expect(result.stdout).not.toContain("{{");
  });

  it("skips the docmap sections without a docs directory", async () => {
    const result = await runMain(["context"], { cwd: temp() });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Docmap");
    expect(result.stdout).not.toContain("Before working on a task");
    expect(result.stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.\n\n" +
        `# Workspace\n\n${workspacePointer}\n\n# AlignFirst Protocols\n\n`,
    );
  });

  it("places project instructions before workspace and dev guidance, then docmap", async () => {
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
    expect(result.stdout).toContain(
      "ask before default-branch operations.\n\n# Project Instructions\n\n" +
        "Run the tests with `npm test`.\n\n# Workspace\n\n",
    );
    expect(result.stdout.match(/^# .+$/gm)).toEqual([
      "# Project Conventions",
      "# Project Instructions",
      "# Workspace",
      "# Development Server",
      "# Docmap Usage",
      "# Documentation",
      "# AlignFirst Protocols",
    ]);
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
    expect(result.stdout).toContain("# Project Instructions\n\nCompanion instructions.\n");
    for (const output of [
      result,
      await runMain(["assistant-instructions"], { cwd: project, home }),
    ]) {
      expect(output).toMatchObject({ code: 0, stderr: "" });
      expect(output.stdout).toContain(configuredWorkspace);
      expect(output.stdout).not.toContain("# Development Server");
    }
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
          `# Workspace\n\n${workspacePointer}\n\n` +
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
    expect(canonical.stdout).toContain("# Assistant Instructions");
    expect(canonical.stdout).toContain("Use the project workflow.");
    expect(warn).not.toHaveBeenCalled();
    const legacy = await runMain(["developer-instructions"], { cwd });
    expect(legacy).toEqual(canonical);
    const warnings = warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("developer-instructions");
    expect(warnings).toContain("assistant-instructions");
  });

  it("shares conventions and workspace guidance without discovering filenames or agent context", async () => {
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
    const context = await runMain(["context"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const heading of ["Project Conventions", "Workspace"]) {
      const sharedSection = context.stdout.match(
        new RegExp(`(?:^|\\n)# ${heading}\\n[\\s\\S]*?(?=\\n# |$)`),
      )?.[0];
      expect(sharedSection).toBeDefined();
      expect(result.stdout).toContain(sharedSection);
    }
    expect(result.stdout).toContain("Ticket IDs: `^TASK-[0-9]+$`");
    expect(result.stdout).toContain("Branch names: `{TICKET_ID}/{slug}`");
    expect(result.stdout).toContain("`type: [TICKET_ID] summary`");
    expect(result.stdout).toContain("Work files: use `.plans`");
    expect(result.stdout).not.toMatch(
      /Ignored|Agent-only|Docmap|Protocols|# Assistant Instructions/,
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
        assistantInstructionsFile: "handbook/workflow.md",
        devServer,
      }),
    );
    const content = "\n# Workflow\r\n\nSee [setup](./setup.md). {{LITERAL}} $HOME\n  ";
    writeFileSync(path, content);
    const result = await runMain(["assistant-instructions"], { cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`# Assistant Instructions\n\nSource: ${path}\n\n${content}`);
    expect(result.stdout.endsWith(content)).toBe(true);
    expect(result.stdout.slice(0, result.stdout.indexOf("Source:")).match(/^# .+$/gm)).toEqual([
      "# Project Conventions",
      "# Workspace",
      "# Development Server",
      "# Assistant Instructions",
    ]);
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
        assistantInstructionsFile: "main.md",
        workspace: {},
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
    expect(result.stdout).toContain(`Source: ${join(linked, "branch.md")}\n\nBranch instructions`);
    expect(result.stdout).not.toContain("Main instructions");
    for (const output of [result, await runMain(["context"], { cwd: nested })]) {
      expect(output).toMatchObject({ code: 0, stderr: "" });
      expect(output.stdout).toContain(configuredWorkspace);
      expect(output.stdout).toContain("alignfirst dev status # inspect its status");
    }
    const mainResult = await runMain(["assistant-instructions"], { cwd: main });
    expect(mainResult.stdout).toContain("Main instructions");
    expect(mainResult.stdout).toContain(configuredWorkspace);
    expect(mainResult.stdout).not.toContain("# Development Server");
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
    expect(result.stdout).toContain(
      `Source: ${join(companion, "workflow.md")}\n\nSelected companion guide`,
    );
    expect(result.stdout).not.toContain("Wrong project guide");
    expect(result.stdout).toContain(configuredWorkspace);
    expect(result.stdout).toContain("alignfirst dev status # inspect its status");
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-context-");
  dirs.push(dir);
  return dir;
}
