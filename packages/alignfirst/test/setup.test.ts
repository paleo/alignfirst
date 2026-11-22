import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SETUP_TOPICS } from "../src/setup/topics.js";
import {
  configureGit,
  git,
  initRepository,
  makeCompanionProject,
  makeTempDir,
  runMain,
} from "./helpers.js";

const dirs: string[] = [];
const CONTRACT_PLACEHOLDERS = [
  "{{CMD}}",
  "{{TOPICS}}",
  "{{SKILLS_INSTALL}}",
  "{{SAMPLE_MANIFEST}}",
  "{{PROJECT_PATH}}",
];
const SETUP_TEMPLATES = fileURLToPath(new URL("../templates/setup/", import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setup init", () => {
  it("adopts the protocols in the project, then reports every step unchanged", async () => {
    const project = makeProject();
    const first = await runMain(["setup", "init", "--ticket-pattern", "^\\d+$"], { cwd: project });
    expect(first.code).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "alignfirst.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      conventions: { ticketIdPattern: "^\\d+$" },
      plans: { autoArchive: true },
    });
    expect(existsSync(join(project, ".plans"))).toBe(true);
    expect(existsSync(join(project, ".local-wt"))).toBe(false);
    expect(readFileSync(join(project, ".gitignore"), "utf-8").split("\n")).toEqual([
      ".plans",
      ".local-wt/",
      "",
    ]);
    expect((await runMain(["setup", "instructions"], { cwd: project })).stdout).toMatch(
      /^Status: current$/m,
    );
    const files = ["alignfirst.json", ".gitignore", "AGENTS.md"].map((name) =>
      readFileSync(join(project, name), "utf-8"),
    );
    const second = await runMain(["setup", "init"], { cwd: project });
    expect(second.code).toBe(0);
    expect(second.stdout).not.toMatch(/: (created|updated)\b/);
    expect(
      ["alignfirst.json", ".gitignore", "AGENTS.md"].map((name) =>
        readFileSync(join(project, name), "utf-8"),
      ),
    ).toEqual(files);
  });

  it("keeps the repository clean with a companion default location", async () => {
    const { root, home, project, companion } = makeCompanionProject({});
    dirs.push(root);
    rmSync(join(home, ".alignfirst", "companions", "registry.json"));
    const result = await runMain(["setup", "init", "--default-location", "companion"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(0);
    expect(git(project, "status", "--porcelain", "--ignored")).toBe("");
    expect(existsSync(join(companion, "alignfirst.json"))).toBe(true);
    expect(existsSync(join(companion, ".plans"))).toBe(true);
  });

  it("fails on --item without --default-location and changes nothing", async () => {
    const project = makeProject();
    const result = await runMain(["setup", "init", "--item", "docs=project"], { cwd: project });
    expect(result.code).toBe(1);
    expect(git(project, "status", "--porcelain", "--ignored")).toBe("");
  });

  it("validates the work files after the companion step before registering", async () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    rmSync(registry);
    mkdirSync(join(project, ".plans"));
    writeFileSync(join(project, ".plans", "notes.md"), "tracked\n");
    git(project, "add", ".plans");
    git(project, "commit", "--quiet", "-m", "track plans");
    const result = await runMain(["setup", "init", "--default-location", "project"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(existsSync(registry)).toBe(false);
  });

  it("keeps the bytes of an existing configuration", async () => {
    const project = makeProject();
    const config = '{\n  "schemaVersion": 1 }\n';
    writeFileSync(join(project, "alignfirst.json"), config);
    const result = await runMain(["setup", "init", "--default-branch", "trunk"], {
      cwd: project,
    });
    expect(result.code).toBe(0);
    expect(readFileSync(join(project, "alignfirst.json"), "utf-8")).toBe(config);
  });

  it("writes the ignore rules to the exclude file with --git-exclude", async () => {
    const project = makeProject();
    const result = await runMain(["setup", "init", "--git-exclude"], { cwd: project });
    expect(result.code).toBe(0);
    expect(existsSync(join(project, ".gitignore"))).toBe(false);
    expect(git(project, "check-ignore", "--", ".plans", ".local-wt/")).toBe(".plans\n.local-wt/");
  });
});

describe("setup instructions", () => {
  it("refuses a --file the diagnosis does not read, and writes nothing", async () => {
    const project = makeProject();
    const result = await runMain(
      ["setup", "instructions", "--write", "--file", ".claude/CLAUDE.md"],
      { cwd: project },
    );
    expect(result.code).toBe(1);
    expect(git(project, "status", "--porcelain", "--ignored")).toBe("");
  });

  it("writes the section to the root file named by --file", async () => {
    const project = makeProject();
    writeFileSync(join(project, "AGENTS.md"), "# Agents\n");
    const result = await runMain(["setup", "instructions", "--write", "--file", "CLAUDE.md"], {
      cwd: project,
    });
    expect(result.code).toBe(0);
    expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toBe("# Agents\n");
    expect((await runMain(["setup", "instructions"], { cwd: project })).stdout).toMatch(
      /^Location: CLAUDE\.md:\d+$/m,
    );
  });
});

describe("setup guide", () => {
  it.each(SETUP_TOPICS.map(({ name }) => name))("renders %s without placeholders", async (name) => {
    const result = await runMain(["setup", "guide", name], { cwd: temp() });
    expect(result.code).toBe(0);
    for (const placeholder of CONTRACT_PLACEHOLDERS)
      expect(result.stdout).not.toContain(placeholder);
  });

  it("names only registered topics in the templates", () => {
    const names = new Set(SETUP_TOPICS.map(({ name }) => name));
    for (const file of readdirSync(SETUP_TEMPLATES, { recursive: true, encoding: "utf-8" })) {
      if (!file.endsWith(".md")) continue;
      const content = readFileSync(join(SETUP_TEMPLATES, file), "utf-8");
      for (const [, topic] of content.matchAll(/setup guide ([a-z0-9-]+)/g))
        expect(names, `${file} names ${topic}`).toContain(topic);
    }
  });

  it("fails on an unknown topic", async () => {
    const result = await runMain(["setup", "guide", "unknown-topic"], { cwd: temp() });
    expect(result.code).toBe(1);
  });
});

describe("setup", () => {
  it("prints the report and the entry guide with an invalid configuration", async () => {
    const project = makeProject();
    writeFileSync(join(project, "alignfirst.json"), "{ invalid");
    const result = await runMain(["setup"], { cwd: project });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^# Project state$/m);
    for (const { name } of SETUP_TOPICS) expect(result.stdout).toContain(`\`${name}\``);
  });

  it("nests every global skill under the summary line", async () => {
    const result = await runMain(["setup"], { cwd: makeProject() });
    expect(result.stdout).toContain(
      "- Global skills: on disk; the session's skill list shows availability\n  - alignfirst none\n",
    );
  });
});

describe("setup state report", () => {
  it("reports the directory-only .local-wt/ rule as ignored before the directory exists", async () => {
    const project = makeProject();
    writeFileSync(join(project, ".gitignore"), ".local-wt/\n");
    const result = await runMain(["setup"], { cwd: project });
    expect(result.stdout).toMatch(/^- Workspace: .*\.local-wt\/ ignored\b/m);
  });

  it("reports a shared .local symlink in a linked worktree as ignored", async () => {
    const project = makeProject();
    writeFileSync(join(project, ".gitignore"), ".local\n");
    git(project, "add", ".gitignore");
    git(project, "commit", "--quiet", "-m", "ignore .local");
    mkdirSync(join(project, ".local"));
    const linked = join(dirname(project), "linked");
    git(project, "worktree", "add", "--quiet", "-b", "linked", linked);
    symlinkSync(join(project, ".local"), join(linked, ".local"));
    const result = await runMain(["setup"], { cwd: linked });
    expect(result.stdout).toMatch(/^- Workspace: .*\.local\/ ignored$/m);
  });
});

function makeProject(): string {
  const root = temp();
  configureGit(root);
  const project = join(root, "project");
  initRepository(project);
  return project;
}

function temp(): string {
  const dir = makeTempDir("alignfirst-setup-");
  dirs.push(dir);
  return dir;
}
