import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import type { CommandContext } from "../src/context.js";
import {
  nestedCompanionDirs,
  sharedCompanionDirs,
  strayRegistryKeys,
} from "../src/project-layout.js";
import { findInstalledSkill, resolveSkillRoots } from "../src/skills.js";
import { makeCompanionProject, makeSink, makeTempDir, runMain, writeRegistry } from "./helpers.js";

const dirs: string[] = [];
const DEFAULT_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills"];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("doctor command", () => {
  it("renders the external Skills update through the launching runner", async () => {
    const home = temp();
    installSkill(join(home, ".agents", "skills"), "alignfirst", "3.0.0");
    const stdout = makeSink();
    const env = { npm_config_user_agent: "bun/1", npm_command: "exec", PATH: "" };
    expect(
      await main({
        argv: ["runtime", "alignfirst", "doctor"],
        cwd: home,
        home,
        env,
        evidence: { runtime: "bun", env, cwd: home, executable: "/runtime" },
        stdout,
        stderr: makeSink(),
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("bunx --bun skills update --global --yes");
  });

  it("reports a profile without a companion and warns about unmatched profile keys", async () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    writeRegistry(home, {
      projects: {
        "~/app": { aligndev: { profile: "unprovisioned" } },
        "~/gone": { aligndev: { profile: "work" } },
      },
    });
    const result = await runMain(["doctor"], { cwd: project, home });
    expect(result.stdout).toContain("unprovisioned");
    expect(result.stdout).toContain("~/gone");
  });

  it("reports selected companion and project paths", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      docs: "companion",
      ".plans": "project",
    });
    dirs.push(root);
    mkdirSync(join(project, ".plans"));
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    expect(result.code).toBe(0);
    for (const path of [
      join(companion, "alignfirst.json"),
      join(companion, ".alignfirst-instructions"),
      join(companion, "docs"),
      join(project, ".local-wt"),
      join(project, ".plans"),
    ])
      expect(result.stdout).toContain(path);
  });

  it("accepts a missing assistant guide in a companion placement", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      assistantInstructionsFile: "companion",
      docs: "companion",
    });
    dirs.push(root);
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    expect(levelOf(result.stdout, join(companion, "ASSISTANTS.md"))).toBe("ok");
    expect(levelOf(result.stdout, join(companion, "docs"))).toBe("warn");
  });

  it("continues after an invalid project config", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, "alignfirst.json"), "{");
    installSkill(join(cwd, ".agents", "skills"), "alignfirst", "4.2.3");
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(cwd, "alignfirst.json"));
    expect(result.stdout).toContain("4.2.3");
  });

  it("reports the configured default branch and installed skill version", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        conventions: { git: { defaultBranch: "release/integration" } },
      }),
    );
    installSkill(join(cwd, ".agents", "skills"), "alignfirst", "3.12.0");
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.stdout).toContain("release/integration");
    expect(result.stdout).toContain("3.12.0");
  });

  it("reports the aligndev skill at info level without expecting it", async () => {
    const home = temp();
    const root = join(home, ".agents", "skills");
    installSkill(root, "alspec", "4.0.0");
    const absent = await runMain(["doctor"], { cwd: home, env: { PATH: "" }, home });
    expect(levelOf(absent.stdout, "aligndev")).toBe("info");

    installSkill(root, "aligndev", "1.0.1");
    const present = await runMain(["doctor"], { cwd: home, env: { PATH: "" }, home });
    expect(levelOf(present.stdout, "aligndev 1.0.1")).toBe("info");
    expect(present.stdout).toContain(root);
  });
});

describe("resolveSkillRoots", () => {
  it.each([
    ["unset", undefined, (home: string) => join(home, ".pi", "agent")],
    ["empty", "", (home: string) => join(home, ".pi", "agent")],
    ["bare tilde", "~", (home: string) => home],
    ["tilde", "~/custom agent", (home: string) => join(home, "custom agent")],
    ["file URL", pathToFileURL("/opt/custom agent").href, () => join("/opt", "custom agent")],
    [
      "relative, without shell expansion",
      "~otheruser/$HOME",
      (_home: string, cwd: string) => join(cwd, "~otheruser", "$HOME"),
    ],
  ])("resolves the Pi root from the supplied context: %s", (_case, value, agentDir) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(temp(), "ambient-agent"));
    vi.stubEnv("HOME", temp());
    const home = temp();
    const cwd = temp();
    const roots = resolveSkillRoots(makeContext(home, cwd, { PI_CODING_AGENT_DIR: value }));
    expect(roots).toEqual([
      ...DEFAULT_ROOTS.map((root) => join(home, root)),
      join(agentDir(home, cwd), "skills"),
    ]);
  });

  it("replaces only the default Pi root and preserves shared/Claude/Codex precedence", () => {
    const home = temp();
    installSkill(join(home, ".pi", "agent", "skills"), "alplan", "4.0.0");
    installSkill(join(home, ".claude", "skills"), "al", "4.0.1");
    installSkill(join(home, ".codex", "skills"), "al", "4.0.2");
    const custom = join(home, "custom");
    const roots = resolveSkillRoots(makeContext(home, home, { PI_CODING_AGENT_DIR: custom }));
    expect(roots).toEqual([
      ...DEFAULT_ROOTS.map((root) => join(home, root)),
      join(custom, "skills"),
    ]);
    expect(findInstalledSkill(roots, "al")).toEqual({
      root: join(home, ".claude", "skills"),
      version: "4.0.1",
    });
    expect(findInstalledSkill(roots, "alplan")).toBeUndefined();
  });

  it("deduplicates canonical roots without changing precedence and tolerates missing roots", () => {
    const home = temp();
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    symlinkSync(join(home, ".agents", "skills"), join(home, ".pi", "agent", "skills"));
    expect(resolveSkillRoots(makeContext(home, home, {}))).toEqual(
      DEFAULT_ROOTS.map((root) => join(home, root)),
    );
  });
});

describe("registry warnings", () => {
  it("lists the keys that name no git main worktree", () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    mkdirSync(join(project, "src"));
    writeRegistry(home, {
      projects: {
        "~": { dir: "home" },
        "~/app": { dir: "app" },
        "~/app/src": { dir: "app_src" },
        "~/gone": { dir: "gone" },
      },
    });
    expect(strayRegistryKeys(home).sort()).toEqual(["~", "~/app/src", "~/gone"]);
  });

  it("groups the keys sharing a companion directory, whatever its spelling", () => {
    const home = temp();
    writeRegistry(home, {
      projects: {
        "~/app": { dir: "app" },
        "~/one": { dir: "shared" },
        "~/two": { dir: "~/.alignfirst/companions/shared" },
      },
    });
    expect(sharedCompanionDirs(home)).toEqual([
      { dir: join(companionsDir(home), "shared"), keys: ["~/one", "~/two"] },
    ]);
  });

  it("finds a companion directory inside another key's companion directory", () => {
    const home = temp();
    writeRegistry(home, {
      projects: { "~/app": { dir: "app" }, "~/one": { dir: "team" }, "~/two": { dir: "team/two" } },
    });
    const team = join(companionsDir(home), "team");
    expect(nestedCompanionDirs(home)).toEqual([
      { dir: join(team, "two"), keys: ["~/two"], outerDir: team, outerKeys: ["~/one"] },
    ]);
  });
});

/** The level of the first doctor line mentioning `fragment`. */
function levelOf(stdout: string, fragment: string): string | undefined {
  const line = stdout.split("\n").find((candidate) => candidate.includes(fragment));
  return line === undefined ? undefined : /^\[(\w+)\]/u.exec(line)?.[1];
}

function makeContext(home: string, cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    home,
    cwd,
    env,
    form: "alignfirst",
    version: "0.0.0",
    stdout: makeSink(),
    stderr: makeSink(),
  };
}

function companionsDir(home: string): string {
  return join(realpathSync(home), ".alignfirst", "companions");
}

function installSkill(root: string, name: string, version: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nmetadata:\n  version: "${version}"\n---\n`);
}

function temp(): string {
  const dir = makeTempDir("alignfirst-doctor-");
  dirs.push(dir);
  return dir;
}
