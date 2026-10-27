import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { resolveSkillRoots } from "../src/skills.js";
import {
  git,
  makeCompanionProject,
  makeTempDir,
  runMain,
  writeRegistry,
  makeSink,
} from "./helpers.js";

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
      expect(stdout.text()).toContain(`update: ${runner} skills update --global --yes`);
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
    expect(result.stdout).toContain("[ok] Companion: none");
    expect(result.stdout).toContain("[ok] AlignDev: profile unprovisioned");
    expect(result.stdout).toContain("key ~/gone names no git main worktree");
    expect(result.stdout).not.toContain("share the companion");
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
    expect(result.stdout).toContain(`[ok] Skills: alignfirst 4.2.0 (${root})`);
    expect(result.stdout).toContain(`[ok] Skills: alspec 4.1.0 (${root})`);
    expect(result.stdout).toContain("[warn] Skills: alplan missing");
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
    expect(result.stdout).toContain(
      `[ok] Skills: alspec 4.0.0 (${join(home, ".agents", "skills")})`,
    );
    expect(result.stdout).toContain(`[ok] Skills: al 4.0.1 (${join(home, ".claude", "skills")})`);
    expect(result.stdout).toContain("[warn] Skills: alplan missing");
  });

  it("does not fall back to default Pi skills when the custom root is missing", async () => {
    const home = temp();
    installSkill(join(home, ".pi", "agent", "skills"), "alspec", "4.0.0");
    const result = await runMain(["doctor"], {
      cwd: home,
      home,
      env: { PI_CODING_AGENT_DIR: "missing" },
    });
    expect(result.stdout).toContain("[ok] Skills: no command skill installed");
  });

  it.each(["3.9.0", undefined])("retains Pi version warnings: %s", async (version) => {
    const home = temp();
    installSkill(join(home, ".pi", "agent", "skills"), "alignfirst", version);
    const result = await runMain(["doctor"], { cwd: home, home });
    expect(result.stdout).toContain(
      `[warn] Skills: alignfirst ${version ?? "unknown"} predates v4`,
    );
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
  it("always reports every section in an empty directory", async () => {
    const cwd = temp();
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    for (const section of [
      "CLI",
      "alignfirst",
      "Workspace",
      "Companion",
      "Git",
      "Work files",
      "Docmap",
      "Skills",
    ])
      expect(result.stdout).toContain(`] ${section}:`);
    expect(result.stdout).toContain(`[ok] alignfirst: ${join(cwd, "alignfirst.json")} (missing)`);
    expect(result.stdout).toContain(
      `[ok] Companion: registry absent (${join(cwd, ".alignfirst", "companions", "registry.json")})\n[ok] Companion: none\n`,
    );
    expect(result.stdout).toContain("[warn] Git: default branch unresolved");
    expect(result.stdout).toContain("[ok] Docmap: docs/ none");
    expect(result.stdout).toContain("[ok] Skills: alignfirst none");
    expect(result.stdout).toContain("[ok] Skills: no command skill installed");
    expect(result.stdout).not.toContain("Skills: aligndev");
  });

  it("reports the companion and warns about a missing item set to companion", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      docs: "companion",
      ".plans": "project",
    });
    dirs.push(root);
    mkdirSync(join(project, ".plans"));
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      [
        `[ok] Companion: registry valid (${join(home, ".alignfirst", "companions", "registry.json")})`,
        "[ok] Companion: key ~/app",
        `[ok] Companion: directory ${companion} (missing)`,
        `[ok] Companion: alignfirst (auto): ${join(companion, "alignfirst.json")} (companion, missing)`,
        `[ok] Companion: .alignfirst-instructions (auto): ${join(companion, ".alignfirst-instructions")} (companion, missing)`,
        `[ok] Companion: DEVELOPERS.md (auto): ${join(companion, "DEVELOPERS.md")} (companion, missing)`,
        `[warn] Companion: docs (companion): ${join(companion, "docs")} (companion, missing)`,
        `[ok] Companion: .plans (project): ${join(project, ".plans")} (project)`,
        `[ok] Companion: _aligndev (auto): ${join(project, ".plans")} (project)`,
        "[ok] AlignDev: profile none",
        "[warn] Git:",
      ].join("\n"),
    );
    expect(result.stdout).toContain("[ok] Work files: local");
  });

  it.each(["tracked", "differentTarget"])(
    "reports %s plans as a Work files error and continues other sections",
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
      const result = await runMain(["doctor"], { cwd, home, env: { PATH: "" } });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain(
        `[error] Work files: ${check.stderr.trim().split("\n")[0]}\n`,
      );
      expect(result.stdout).not.toContain("[ok] Work files:");
      expect(result.stdout).toContain("] Docmap:");
      expect(result.stdout).toContain("] Skills:");
    },
  );

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
    for (const key of ["~", "~/app/src", "~/gone"])
      expect(result.stdout).toContain(
        `[warn] Companion: key ${key} names no git main worktree (ignored)\n`,
      );
    expect(result.stdout).toContain("[ok] Companion: key ~/app\n");
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
    expect(result.stdout).toContain(
      `[warn] Companion: keys ~/one, ~/two share the companion directory ${join(home, ".alignfirst", "companions", "shared")}\n`,
    );
  });

  it("warns about a companion directory inside another key's companion directory", async () => {
    const { root, home, project } = makeCompanionProject({});
    dirs.push(root);
    writeRegistry(home, {
      projects: { "~/app": { dir: "app" }, "~/one": { dir: "team" }, "~/two": { dir: "team/two" } },
    });
    const result = await runMain(["doctor"], { cwd: project, env: { PATH: "" }, home });
    const team = join(home, ".alignfirst", "companions", "team");
    expect(result.stdout).toContain(
      `[warn] Companion: companion directory ${join(team, "two")} (~/two) is inside ${team} (~/one)\n`,
    );
  });

  it("reports an invalid registry in every section that needs the layout", async () => {
    const cwd = temp();
    writeRegistry(cwd, {});
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    for (const section of ["alignfirst", "Companion", "Work files", "Docmap"])
      expect(result.stdout).toContain(
        `[error] ${section}: Invalid ${cwd}/.alignfirst/companions/registry.json: projects`,
      );
    expect(result.stdout).toContain("[ok] Skills: alignfirst none");
  });

  it("reports unknown project settings and invalid workspace metadata independently", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, "alignfirst.jsonc"), '{"schemaVersion":1,"plans":{"folder":"x"}}');
    writeFileSync(join(cwd, "alignfirst-workspace.json"), '{"schemaVersion":2}');
    const result = await runMain(["doctor"], { cwd, home: cwd });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`[error] alignfirst: Invalid ${join(cwd, "alignfirst.jsonc")}`);
    expect(result.stdout).toContain("/plans/folder");
    expect(result.stdout).toContain("[error] Workspace:");
    expect(result.stdout).toContain("update alignfirst");
  });

  it("continues after an invalid project config", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, "alignfirst.json"), "{");
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[error] alignfirst: Invalid");
    expect(result.stdout).toContain("] Work files:");
  });

  it("reports the configured default branch and skill generation", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, git: { defaultBranch: "main" } }),
    );
    const skillDir = join(cwd, ".agents", "skills", "alignfirst");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), '---\nmetadata:\n  version: "3.12.0"\n---\n');
    const result = await runMain(["doctor"], {
      cwd,
      env: { PATH: "" },
      home: cwd,
    });
    expect(result.stdout).toContain("[ok] Git: default branch main (git.defaultBranch)");
    expect(result.stdout).toContain("[warn] Skills: alignfirst 3.12.0 predates v4");

    writeFileSync(join(skillDir, "SKILL.md"), '---\nmetadata:\n  version: "4.0.0"\n---\n');
    const current = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(current.stdout).toContain("[ok] Skills: alignfirst 4.0.0");
  });

  it("warns about missing command skills only once one is installed", async () => {
    const cwd = temp();
    const skillDir = join(cwd, ".agents", "skills", "alspec");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), '---\nmetadata:\n  version: "4.0.0"\n---\n');
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.stdout).toContain("[ok] Skills: alignfirst none");
    expect(result.stdout).toContain(
      `[ok] Skills: alspec 4.0.0 (${join(cwd, ".agents", "skills")})`,
    );
    expect(result.stdout).toContain("[warn] Skills: alplan missing");
    expect(result.stdout).not.toContain("no command skill installed");
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
