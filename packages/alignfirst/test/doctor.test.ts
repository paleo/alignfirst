import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { resolveSkillRoots } from "../src/skills.js";
import { makeCompanionProject, makeTempDir, runMain, writeRegistry, makeSink } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("doctor command", () => {
  it.each([
    ["node", "npm", "npx -y"],
    ["node", "bun", "bunx"],
    ["bun", "bun", "bunx --bun"],
  ] as const)(
    "renders the external Skills update through %s/%s",
    async (runtime, manager, runner) => {
      const home = temp();
      installSkill(join(home, ".agents", "skills"), "alignfirst", "3.0.0");
      const stdout = makeSink();
      const env = { npm_config_user_agent: `${manager}/1`, npm_command: "exec", PATH: "" };
      expect(
        await main({
          argv: ["runtime", "alignfirst", "doctor"],
          cwd: home,
          home,
          env,
          evidence: { runtime, env, cwd: home, executable: "/runtime" },
          stdout,
          stderr: makeSink(),
        }),
      ).toBe(0);
      expect(stdout.text()).toContain(`${runner} skills update --global --yes`);
    },
  );
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

  it.each([
    "default",
    "empty",
    "absolute",
    "relative",
    "tilde",
    "bareTilde",
    "fileUrl",
    "spaces",
    "literalVariable",
    "otherUser",
  ])("finds native global Pi skills using supplied context: %s", async (kind) => {
    const home = temp();
    const cwd = temp();
    const custom = join(home, "custom agent");
    const cases: Record<string, { value?: string; agent: string }> = {
      default: { agent: join(home, ".pi", "agent") },
      empty: { value: "", agent: join(home, ".pi", "agent") },
      absolute: { value: custom, agent: custom },
      relative: { value: "relative", agent: join(cwd, "relative") },
      tilde: { value: "~/custom agent", agent: custom },
      bareTilde: { value: "~", agent: home },
      fileUrl: { value: pathToFileURL(custom).href, agent: custom },
      spaces: { value: " padded ", agent: join(cwd, " padded ") },
      literalVariable: { value: "$HOME/custom", agent: join(cwd, "$HOME", "custom") },
      otherUser: { value: "~otheruser/custom", agent: join(cwd, "~otheruser", "custom") },
    };
    const { value, agent } = cases[kind];
    const root = join(agent, "skills");
    installSkill(root, "alignfirst", "4.2.0");
    installSkill(root, "alspec", "4.1.0");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(temp(), "ambient-agent"));
    vi.stubEnv("HOME", temp());
    const result = await runMain(["doctor"], { cwd, home, env: { PI_CODING_AGENT_DIR: value } });
    expect(result.stdout).toContain(root);
    expect(result.stdout).toContain("4.2.0");
    expect(result.stdout).toContain("4.1.0");
  });

  it("replaces only the default Pi root and preserves shared/Claude/Codex precedence", async () => {
    const home = temp();
    const custom = join(home, "custom");
    installSkill(join(home, ".pi", "agent", "skills"), "alplan", "4.0.0");
    for (const root of [".agents/skills", ".claude/skills", ".codex/skills", "custom/skills"])
      installSkill(join(home, root), "alspec", "4.0.0");
    installSkill(join(home, ".claude", "skills"), "al", "4.0.1");
    installSkill(join(home, ".codex", "skills"), "al", "4.0.2");
    const result = await runMain(["doctor"], {
      cwd: home,
      home,
      env: { PI_CODING_AGENT_DIR: custom },
    });
    expect(result.stdout).toContain(join(home, ".agents", "skills"));
    expect(result.stdout).toContain(join(home, ".claude", "skills"));
    expect(result.stdout).toContain("4.0.1");
    expect(result.stdout).not.toContain("4.0.2");
    expect(result.stdout).not.toContain(join(home, ".pi", "agent", "skills"));
  });

  it("does not fall back to default Pi skills when the custom root is missing", async () => {
    const home = temp();
    installSkill(join(home, ".pi", "agent", "skills"), "alspec", "4.0.0");
    const result = await runMain(["doctor"], {
      cwd: home,
      home,
      env: { PI_CODING_AGENT_DIR: "missing" },
    });
    expect(result.stdout).not.toContain(join(home, ".pi", "agent", "skills"));
    expect(result.stdout).not.toContain("4.0.0");
  });

  it("deduplicates canonical roots without changing precedence and tolerates missing roots", () => {
    const home = temp();
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    symlinkSync(join(home, ".agents", "skills"), join(home, ".pi", "agent", "skills"));
    const ctx = {
      home,
      cwd: home,
      env: {},
      form: "alignfirst",
      version: "0.0.0",
      stdout: makeSink(),
      stderr: makeSink(),
    };
    expect(resolveSkillRoots(ctx)).toEqual(
      [".agents/skills", ".claude/skills", ".codex/skills"].map((root) => join(home, root)),
    );
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

  it("warns about registry keys that name no git main worktree", async () => {
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
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    expect(result.code).toBe(0);
    for (const key of ["~", "~/app/src", "~/gone"]) expect(result.stdout).toContain(key);
    expect(result.stdout).toContain("~/app");
  });

  it("warns about registry keys that share a companion directory", async () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    writeRegistry(home, {
      projects: {
        "~/app": { dir: "app" },
        "~/one": { dir: "shared" },
        "~/two": { dir: "~/.alignfirst/companions/shared" },
      },
    });
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    expect(result.stdout).toContain(join(home, ".alignfirst", "companions", "shared"));
    expect(result.stdout).toContain("~/one");
    expect(result.stdout).toContain("~/two");
  });

  it("warns about a companion directory inside another key's companion directory", async () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    writeRegistry(home, {
      projects: { "~/app": { dir: "app" }, "~/one": { dir: "team" }, "~/two": { dir: "team/two" } },
    });
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    const team = join(home, ".alignfirst", "companions", "team");
    expect(result.stdout).toContain(join(team, "two"));
    expect(result.stdout).toContain(team);
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
    const skillDir = join(cwd, ".agents", "skills", "alignfirst");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), '---\nmetadata:\n  version: "3.12.0"\n---\n');
    const result = await runMain(["doctor"], {
      cwd,
      env: { PATH: "" },
      home: cwd,
    });
    expect(result.stdout).toContain("release/integration");
    expect(result.stdout).toContain("3.12.0");

    writeFileSync(join(skillDir, "SKILL.md"), '---\nmetadata:\n  version: "4.0.0"\n---\n');
    const current = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(current.stdout).toContain("4.0.0");
    expect(current.stdout).not.toContain("3.12.0");
  });
});

function installSkill(root: string, name: string, version: string | undefined): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    version === undefined ? "# Skill\n" : `---\nmetadata:\n  version: "${version}"\n---\n`,
  );
}

function temp(): string {
  const dir = makeTempDir("alignfirst-doctor-");
  dirs.push(dir);
  return dir;
}
