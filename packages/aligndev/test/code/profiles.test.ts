import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { readMachineId } from "../../src/code/machine-id.js";
import type { QuotaReader } from "../../src/code/quota.js";
import {
  listSessionRecords,
  readCompletion,
  type SessionFrontmatter,
} from "../../src/code/session-file.js";
import { loadConfig, resolveCodeConfig, resolveQuotaConfig } from "../../src/config.js";
import { ALIGNFIRST_BIN, makeSink, writeRegistry, writeSettings } from "../helpers.js";

let root: string;
let home: string;
let project: string;
let nativeA: string;
let nativeB: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aligndev-profiles-"));
  home = join(root, "home");
  project = join(home, "app");
  nativeA = join(root, "native-a");
  nativeB = join(root, "native-b");
  mkdirSync(join(project, ".plans"), { recursive: true });
  mkdirSync(nativeA);
  mkdirSync(nativeB);
  execFileSync("git", ["init", "--quiet", project]);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const index = args.indexOf("--resume");
const store = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude");
fs.mkdirSync(store, {recursive: true});
if (process.env.FIXTURE_AUTH_FAILURE === "1") {
  console.log(JSON.stringify({type: "assistant", error: "authentication_failed"}));
  console.log(JSON.stringify({type: "result", is_error: true, result: "Not logged in. Please run /login."}));
  process.exit(1);
}
const identity = path.join(store, "identity");
let id = "native-session";
if (index >= 0) {
  if (!fs.existsSync(identity)) {
    process.stderr.write("Conversation unavailable in selected native store.");
    process.exit(1);
  }
  id = fs.readFileSync(identity, "utf8");
} else fs.writeFileSync(identity, id);
fs.writeFileSync(${JSON.stringify(join(root, "observed.json"))}, JSON.stringify({
  args, store, directoryPresent: Object.hasOwn(process.env, "CLAUDE_CONFIG_DIR"),
  keyPresent: process.env.TOKEN !== undefined,
  parentPresent: process.env.CLAUDE_CODE_SESSION_ID !== undefined,
  ceiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
}));
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({type: "system", subtype: "init", session_id: id}));
  console.log(JSON.stringify({type: "result", session_id: id, result: "done", is_error: false}));
});
`,
    { mode: 0o755 },
  );
  env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TOKEN: "fixture-secret",
    CLAUDE_CODE_SESSION_ID: "parent",
  };
  settings();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function settings(extra: object = {}) {
  writeSettings(home, {
    code: {
      profile: "a",
      profiles: {
        a: {
          agent: "claude",
          configDir: nativeA,
          defaultModel: "choice",
          modelAliases: { choice: "opus" },
          unset: ["TOKEN"],
        },
        b: {
          agent: "claude",
          configDir: nativeB,
          defaultModel: "sonnet",
          modelAliases: { choice: "haiku" },
          unset: ["TOKEN"],
        },
        pi: { agent: "pi" },
      },
      ...extra,
    },
  });
}

async function launch(
  tokens: string[],
  modelResolver = vi.fn(async (_agent: string, model: string | undefined) => model),
  quotaReader?: QuotaReader,
) {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "aligndev", "code", ...tokens],
    cwd: project,
    home,
    env,
    alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
    stdout,
    stderr,
    modelResolver,
    quotaReader,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), modelResolver };
}

function records() {
  return listSessionRecords(join(project, ".plans"), readMachineId(home));
}

function newest() {
  return records().reduce((a, b) => (a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b));
}

async function historicalRecord(field: string) {
  settings({ profiles: { a: { agent: "claude", configDir: nativeA } } });
  expect((await launch(["new", "-m", "go"])).code).toBe(0);
  const path = newest().path;
  const bytes = readFileSync(path, "utf8").replace(
    /^profile: a\n/m,
    field === "blank" ? "profile: \n" : "",
  );
  writeFileSync(path, bytes);
  expect(newest().frontmatter.profile).toBeNull();
  return { path, bytes };
}

function observed() {
  return JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
}

describe("independent quota configuration", () => {
  it("uses each native profile's finalized coding environment when quota is omitted", () => {
    const config = loadConfig(home);
    for (const [profile, store] of [
      ["a", nativeA],
      ["b", nativeB],
    ]) {
      const code = resolveCodeConfig(config, env, { explicit: profile });
      const quota = resolveQuotaConfig(code, env);
      expect(quota).toEqual({ source: "claude", env: code.childEnv });
      if (quota.source === "none") throw new Error("unexpected disabled quota");
      expect(quota.env.CLAUDE_CONFIG_DIR).toBe(store);
      expect(quota.env.TOKEN).toBeUndefined();
      expect(quota.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    }
  });

  it.each(["claude", "codex"] as const)(
    "shares a null %s coding reset with omitted quota only",
    (agent) => {
      const variable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const caller = Object.freeze({ ...env, [variable]: nativeB });
      settings({ profiles: { a: { agent, configDir: null, unset: ["TOKEN"] } } });
      const code = resolveCodeConfig(loadConfig(home), caller);
      const quota = resolveQuotaConfig(code, caller);
      expect(quota).toEqual({ source: agent, env: code.childEnv });
      if (quota.source === "none") throw new Error("unexpected disabled quota");
      expect(Object.hasOwn(quota.env, variable)).toBe(false);
      expect(quota.env.TOKEN).toBeUndefined();
      expect(caller[variable]).toBe(nativeB);
    },
  );

  it.each(["claude", "codex"] as const)(
    "keeps explicit %s quota omitted/null/string selection independent of coding resets",
    (source) => {
      const variable = source === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      const caller = Object.freeze({
        ...env,
        PATH: env.PATH,
        CLAUDE_CONFIG_DIR: nativeB,
        CODEX_HOME: nativeB,
        PI_CODING_AGENT_DIR: "unrelated-store",
        REMOVE_QUOTA: "remove",
        ANTHROPIC_API_KEY: "private-key",
      });
      for (const configDir of [undefined, null, nativeA]) {
        settings({
          profiles: {
            a: {
              agent: source,
              configDir: configDir === null ? nativeA : null,
              unset: ["TOKEN"],
              env: { CODING_ONLY: "coding" },
              quota: {
                source,
                configDir,
                env: { QUOTA_ONLY: "quota" },
                unset: ["REMOVE_QUOTA"],
              },
            },
          },
        });
        const path = join(home, ".alignfirst/aligndev.settings.json");
        const bytes = readFileSync(path);
        const config = loadConfig(home);
        const stored = config.code.profiles?.a;
        Object.freeze(stored?.unset);
        Object.freeze(stored?.quota?.unset);
        Object.freeze(stored?.quota?.env);
        Object.freeze(stored?.quota);
        const before = JSON.stringify(config);
        const code = resolveCodeConfig(config, caller);
        const quota = resolveQuotaConfig(code, caller);
        if (quota.source === "none") throw new Error("unexpected disabled quota");
        expect(quota.source).toBe(source);
        expect(quota.env[variable]).toBe(
          configDir === null ? undefined : configDir === undefined ? nativeB : nativeA,
        );
        if (configDir === null) expect(Object.hasOwn(quota.env, variable)).toBe(false);
        expect(quota.env).toMatchObject({
          HOME: home,
          PATH: caller.PATH,
          TOKEN: "fixture-secret",
          ANTHROPIC_API_KEY: "private-key",
          PI_CODING_AGENT_DIR: "unrelated-store",
          QUOTA_ONLY: "quota",
          [source === "claude" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: nativeB,
        });
        for (const key of ["CODING_ONLY", "REMOVE_QUOTA", "CLAUDE_CODE_SESSION_ID"])
          expect(quota.env[key]).toBeUndefined();
        expect(code.childEnv[variable]).toBe(configDir === null ? nativeA : undefined);
        expect(code.childEnv.QUOTA_ONLY).toBeUndefined();
        expect(code.childEnv.REMOVE_QUOTA).toBe("remove");
        expect(code.quota?.unset).toEqual(["REMOVE_QUOTA"]);
        expect(caller[variable]).toBe(nativeB);
        expect(JSON.stringify(config)).toBe(before);
        expect(readFileSync(path)).toEqual(bytes);
      }
    },
  );

  it.each(["pi", "claude"] as const)(
    "resolves explicit Codex quota independently of %s overrides",
    (agent) => {
      settings({
        profiles: {
          a: {
            agent,
            configDir: "~/coding",
            env: { CODING_ONLY: "child", CODEX_HOME: "child-store" },
            unset: ["TOKEN"],
            quota: {
              source: "codex",
              configDir: "relative-quota",
              env: { QUOTA_ONLY: "quota", PI_CODING_AGENT: "true" },
              unset: ["REMOVE_QUOTA"],
            },
          },
        },
      });
      const caller = {
        ...env,
        REMOVE_QUOTA: "inherited",
        AI_AGENT: "pi",
        CODEX_THREAD_ID: "parent",
      };
      const original = { ...caller };
      const code = resolveCodeConfig(loadConfig(home), caller);
      const quota = resolveQuotaConfig(code, caller);
      expect(quota.source).toBe("codex");
      if (quota.source === "none") throw new Error("unexpected disabled quota");
      expect(quota.env).toMatchObject({
        CODEX_HOME: join(home, ".alignfirst", "relative-quota"),
        TOKEN: "fixture-secret",
        QUOTA_ONLY: "quota",
      });
      for (const key of [
        "CODING_ONLY",
        "REMOVE_QUOTA",
        "PI_CODING_AGENT",
        "AI_AGENT",
        "CODEX_THREAD_ID",
        "CLAUDE_CODE_SESSION_ID",
      ])
        expect(quota.env[key]).toBeUndefined();
      expect(code.childEnv.CODING_ONLY).toBe("child");
      expect(code.childEnv.CODEX_HOME).toBe("child-store");
      expect(caller).toEqual(original);
    },
  );

  it("allows explicit different-account Claude quota and source-specific home expansion", () => {
    settings({
      profiles: {
        a: {
          agent: "claude",
          configDir: nativeA,
          unset: ["TOKEN"],
          quota: { source: "claude", configDir: "~/quota-claude", env: { MODE: "quota" } },
        },
      },
    });
    const code = resolveCodeConfig(loadConfig(home), env);
    const quota = resolveQuotaConfig(code, env);
    expect(quota).toEqual({
      source: "claude",
      env: expect.objectContaining({
        CLAUDE_CONFIG_DIR: join(home, "quota-claude"),
        MODE: "quota",
        TOKEN: "fixture-secret",
      }),
    });
    expect(code.childEnv.CLAUDE_CONFIG_DIR).toBe(nativeA);
  });

  it("deliberately retains inherited native storage when explicit quota omits configDir", () => {
    settings({
      profiles: {
        a: {
          agent: "pi",
          configDir: nativeA,
          quota: { source: "codex" },
        },
      },
    });
    const caller = { ...env, CODEX_HOME: nativeB };
    expect(resolveQuotaConfig(resolveCodeConfig(loadConfig(home), caller), caller)).toEqual({
      source: "codex",
      env: expect.objectContaining({ CODEX_HOME: nativeB }),
    });
  });

  it("executes the selected quota source, labels its account boundary and leaves the child unchanged", async () => {
    settings({
      profiles: {
        a: {
          agent: "pi",
          configDir: nativeA,
          quota: { source: "codex", configDir: nativeB },
        },
      },
    });
    const reader = vi.fn(async () => "Codex quota\n5 hours: 15% used");
    const result = await launch(["quota"], undefined, reader);
    expect(result.code, result.stderr).toBe(0);
    expect(reader).toHaveBeenCalledWith("codex", {
      cwd: project,
      env: expect.objectContaining({ CODEX_HOME: nativeB }),
    });
    expect(result.stdout).toContain("Profile: a; native source: codex");
    expect(result.stdout).toContain("account pairing with the coding agent is not verified");
    expect(result.stdout).not.toContain("fixture-secret");
    expect(resolveCodeConfig(loadConfig(home), env).childEnv.PI_CODING_AGENT_DIR).toBe(nativeA);
    expect(records()).toHaveLength(0);
  });

  it.each([undefined, { source: "none" }])(
    "spawns nothing for unsupported/disabled quota %j",
    async (quota) => {
      settings({ profiles: { a: { agent: "pi", quota } } });
      const reader = vi.fn(async () => "must not run");
      const result = await launch(["quota"], undefined, reader);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        quota === undefined ? "set quota.source" : "Quota is disabled",
      );
      expect(reader).not.toHaveBeenCalled();
      expect(result.modelResolver).not.toHaveBeenCalled();
    },
  );

  it("uses new-session project/explicit precedence rather than a recorded run's profile", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    settings({ profile: "b" });
    const reader = vi.fn(async () => "limits");
    expect((await launch(["quota"], undefined, reader)).stdout).toContain("Profile: b;");
    writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "a" } } } });
    expect((await launch(["quota"], undefined, reader)).stdout).toContain("Profile: a;");
    expect((await launch(["quota", "--profile", "b"], undefined, reader)).stdout).toContain(
      "Profile: b;",
    );
  });
});

describe("effective profiles through CLI launch and resume", () => {
  it("unsets inherited storage for a real null-configured child and describes the reset", async () => {
    settings({ profiles: { a: { agent: "claude", configDir: null, unset: ["TOKEN"] } } });
    env.CLAUDE_CONFIG_DIR = nativeB;
    const bytes = readFileSync(join(home, ".alignfirst/aligndev.settings.json"));
    const initial = await launch(["new", "-m", "go"]);
    expect(initial.code, initial.stderr).toBe(0);
    expect(observed()).toMatchObject({
      store: join(home, ".claude"),
      directoryPresent: false,
      keyPresent: false,
      parentPresent: false,
      ceiling: "0",
    });
    expect(initial.modelResolver).toHaveBeenCalledWith("claude", undefined, {
      cwd: project,
      env: expect.not.objectContaining({ CLAUDE_CONFIG_DIR: expect.anything() }),
    });
    expect(existsSync(join(home, ".claude/identity"))).toBe(true);
    expect(existsSync(join(nativeB, "identity"))).toBe(false);
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(newest().frontmatter).toMatchObject({ profile: "a", sessionId: "native-session" });
    expect(observed().directoryPresent).toBe(false);
    const help = await launch(["--help"]);
    const stdout = makeSink();
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "guide", "code"],
        cwd: project,
        home,
        env,
        alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
        stdout,
        stderr,
      }),
      stderr.text(),
    ).toBe(0);
    env.FIXTURE_AUTH_FAILURE = "1";
    const failed = await launch(["new", "-m", "go", "--quiet"]);
    expect(failed.code, failed.stderr).toBe(2);
    for (const text of [help.stdout, stdout.text(), failed.stderr]) {
      expect(text).toContain("CLAUDE_CONFIG_DIR: unset by configDir: null; native defaults apply");
      expect(text).toContain("HOME: inherited environment (value omitted)");
      expect(text).not.toContain(nativeB);
      expect(text).not.toContain("fixture-secret");
    }
    expect(env.CLAUDE_CONFIG_DIR).toBe(nativeB);
    expect(readFileSync(join(home, ".alignfirst/aligndev.settings.json"))).toEqual(bytes);
  });

  it.each([false, true])(
    "records inferred singleton/preferred profiles and preserves named resume: %s",
    async (multiple) => {
      const profiles = loadConfig(home).code.profiles;
      settings({
        profile: undefined,
        profiles: {
          a: { ...profiles?.a, default: multiple },
          ...(multiple ? { b: profiles?.b } : {}),
        },
      });
      env.CLAUDECODE = "1";
      const initial = await launch(["new", "-m", "go"]);
      expect(initial.code, initial.stderr).toBe(0);
      expect(newest().frontmatter).toMatchObject({ profile: "a", model: "choice" });
      expect(observed()).toMatchObject({ store: nativeA, keyPresent: false });
      expect(initial.modelResolver).toHaveBeenCalledWith("claude", "opus", expect.anything());
      settings({
        profile: "b",
        profiles: {
          a: { ...profiles?.a, default: false },
          b: { ...profiles?.b, default: true },
        },
      });
      const resumed = await launch(["resume", "native-session", "-m", "more"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(newest().frontmatter.profile).toBe("a");
      expect(observed().store).toBe(nativeA);
    },
  );

  it.each([
    ["blank", false],
    ["missing", false],
    ["blank", true],
    ["missing", true],
  ])(
    "keeps historical %s profiles on built-ins despite configured inference: multiple=%s",
    async (field, multiple) => {
      const historical = await historicalRecord(field);
      settings({
        profile: undefined,
        profiles: {
          a: {
            agent: "claude",
            configDir: nativeB,
            default: true,
            defaultModel: "opus",
            unset: ["TOKEN"],
          },
          ...(multiple ? { b: { agent: "claude", configDir: nativeB } } : {}),
        },
      });
      env.CLAUDECODE = "1";
      env.CLAUDE_CONFIG_DIR = nativeA;
      const resumed = await launch(["resume", "native-session", "-m", "more"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(newest().frontmatter).toMatchObject({ profile: null, model: null, agent: "claude" });
      expect(observed()).toMatchObject({ store: nativeA, keyPresent: true });
      expect(observed().args).not.toContain("--model");
      expect(readFileSync(historical.path, "utf8")).toBe(historical.bytes);
    },
  );

  it.each([{}, { CLAUDECODE: "1", AI_AGENT: "pi" }, { AI_AGENT: "pi" }])(
    "keeps detection and same-agent guards on historical fallback %j",
    async (markers) => {
      const historical = await historicalRecord("missing");
      settings({
        profile: undefined,
        profiles: { only: { agent: "claude", configDir: nativeA, default: true } },
      });
      Object.assign(env, markers);
      const resumed = await launch(["resume", "native-session", "-m", "more"]);
      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toContain(
        "AI_AGENT" in markers && !("CLAUDECODE" in markers)
          ? "belongs to agent claude"
          : "coding agent",
      );
      expect(resumed.modelResolver).not.toHaveBeenCalled();
      expect(records()).toHaveLength(1);
      expect(readFileSync(historical.path, "utf8")).toBe(historical.bytes);
    },
  );

  it.each(["explicit", "project", "global"])(
    "allows deliberate %s replacement of null history",
    async (selection) => {
      const historical = await historicalRecord("blank");
      settings({ profile: selection === "global" ? "b" : undefined });
      writeFileSync(join(nativeB, "identity"), "native-session");
      if (selection === "project")
        writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "b" } } } });
      const resumed = await launch([
        "resume",
        "native-session",
        "-m",
        "more",
        ...(selection === "explicit" ? ["--profile", "b"] : []),
      ]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(newest().frontmatter).toMatchObject({ profile: "b", model: null });
      expect(observed().store).toBe(nativeB);
      expect(readFileSync(historical.path, "utf8")).toBe(historical.bytes);
    },
  );

  it("uses the actual-cwd project selection for guide/help and preserves subcommand help overrides", async () => {
    writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "b" } } } });
    const help = await launch(["--help"]);
    expect(help.stdout).toContain("Effective profile: b");
    for (const args of [["--help"], ["new", "--help"], ["resume", "--help"], ["quota", "--help"]]) {
      const selected = await launch([...args, "--profile", "a"]);
      expect(selected.code, selected.stderr).toBe(0);
      expect(selected.stdout).toContain("Effective profile: a");
      expect(selected.modelResolver).not.toHaveBeenCalled();
    }
    const stdout = makeSink();
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "guide", "code"],
        cwd: project,
        home,
        env,
        alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
        stdout,
        stderr,
      }),
      stderr.text(),
    ).toBe(0);
    expect(stdout.text()).toContain("Effective profile: `b`");
    expect(stdout.text()).toContain(nativeB);
    expect(stdout.text()).toContain("`sonnet`");
    expect(stdout.text()).not.toContain("fixture-secret");
    expect(records()).toHaveLength(0);
    expect(existsSync(join(nativeB, "identity"))).toBe(false);
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["codex", "CODEX_HOME"],
    ["pi", "PI_CODING_AGENT_DIR"],
  ] as const)(
    "describes %s profile env storage in help and guide without values",
    async (agent, variable) => {
      settings({
        profiles: {
          a: { agent, env: { [variable]: "private-store-value", HOME: "private-home-value" } },
        },
      });
      const help = await launch(["--help"]);
      const stdout = makeSink();
      const stderr = makeSink();
      const guideCode = await main({
        argv: ["node", "aligndev", "guide", "code"],
        cwd: project,
        home,
        env,
        alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
        stdout,
        stderr,
      });
      expect(help.code, help.stderr).toBe(0);
      expect(guideCode, stderr.text()).toBe(0);
      for (const text of [help.stdout, stdout.text()]) {
        expect(text).toContain(`${variable}: profile env override (value omitted)`);
        expect(text).toContain("HOME: profile env override (value omitted)");
        expect(text).toContain("same effective environment as the child");
        expect(text).toContain("unset/env/configDir");
        expect(text).not.toContain("private-store-value");
        expect(text).not.toContain("private-home-value");
      }
    },
  );

  it("distinguishes inherited native storage from profile removal without values", async () => {
    env.CLAUDE_CONFIG_DIR = "inherited-private-store";
    settings({ profiles: { a: { agent: "claude" } } });
    const inherited = await launch(["--help"]);
    expect(inherited.stdout).toContain("CLAUDE_CONFIG_DIR: inherited environment (value omitted)");
    expect(inherited.stdout).not.toContain("inherited-private-store");
    settings({ profiles: { a: { agent: "claude", unset: ["CLAUDE_CONFIG_DIR"] } } });
    expect((await launch(["--help"])).stdout).toContain(
      "CLAUDE_CONFIG_DIR: unset by profile; native defaults apply",
    );
  });

  it("requires the selected effective environment for login after authentication failure", async () => {
    settings({
      profiles: {
        a: { agent: "claude", env: { CLAUDE_CONFIG_DIR: nativeA, FIXTURE_AUTH_FAILURE: "1" } },
      },
    });
    const failed = await launch(["new", "-m", "go", "--quiet"]);
    expect(failed.code, failed.stderr).toBe(2);
    expect(failed.stderr).toContain("CLAUDE_CONFIG_DIR: profile env override (value omitted)");
    expect(failed.stderr).toContain("same effective environment as the child");
    expect(failed.stderr).toContain("unset/env/configDir");
    expect(failed.stderr).not.toContain(nativeA);
    expect(failed.stderr).not.toContain("fixture-secret");
  });

  it("sanitizes native model discovery failures before diagnostics and durable completion", async () => {
    writeFileSync(
      join(root, "bin", "codex"),
      `#!${process.execPath}
process.stdout.write("native-model-secret");
process.stderr.write("native-model-secret");
process.exitCode = 1;
`,
      { mode: 0o755 },
    );
    settings({ profiles: { a: { agent: "codex", defaultModel: "sol", configDir: nativeA } } });
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "new", "-m", "go"],
      cwd: project,
      home,
      env,
      alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Could not resolve the codex model");
    expect(stderr.text()).toContain("update the Codex CLI");
    expect(stdout.text() + stderr.text()).not.toContain("native-model-secret");
    expect(readFileSync(newest().path, "utf8")).not.toContain("native-model-secret");
    expect(readCompletion(newest().path).frontmatter).toMatchObject({
      status: "failed",
      exitReason: "error",
    });
  });

  it.each([false, true])(
    "keeps initial identity and model-discovery failure metadata for resume=%s",
    async (resume) => {
      expect((await launch(["new", "-m", "go"])).code).toBe(0);
      const originalFile = newest().path;
      const original = readFileSync(originalFile, "utf8");
      const initialMetadata: SessionFrontmatter[] = [];
      const modelResolver = vi.fn(async () => {
        initialMetadata.push(newest().frontmatter);
        throw new Error("fixture model discovery failure");
      });
      const failed = await launch(
        [
          resume ? "resume" : "new",
          ...(resume ? ["native-session"] : []),
          "-m",
          "go",
          "--profile",
          "b",
        ],
        modelResolver,
      );
      expect(failed.code).toBe(1);
      expect(modelResolver).toHaveBeenCalledOnce();
      expect(initialMetadata).toEqual([
        expect.objectContaining({
          status: "running",
          profile: "b",
          sessionId: resume ? "native-session" : null,
        }),
      ]);
      expect(readCompletion(newest().path).frontmatter).toMatchObject({
        status: "failed",
        profile: "b",
        model: resume ? "choice" : "sonnet",
        sessionId: resume ? "native-session" : null,
        exitReason: "error",
      });
      const status = await launch(["status", newest().path, "--result"]);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain(`sessionId: ${resume ? "native-session" : ""}\n`);
      expect(status.stdout).toContain("Could not resolve the claude model");
      expect(existsSync(join(nativeB, "identity"))).toBe(false);
      expect(readFileSync(originalFile, "utf8")).toBe(original);
    },
  );

  it("retains resume identity on authentication failure before a native header", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    env.FIXTURE_AUTH_FAILURE = "1";
    const failed = await launch(["resume", "native-session", "-m", "more", "--profile", "b"]);
    expect(failed.code).toBe(2);
    expect(readCompletion(newest().path).frontmatter).toMatchObject({
      status: "failed",
      profile: "b",
      model: "choice",
      sessionId: "native-session",
      exitReason: "auth_required",
    });
  });

  it("round-trips a multiline profile and model through completion, status and resume", async () => {
    const profile = "work\naccount";
    const model = "chosen\nmodel";
    settings({
      profile,
      profiles: {
        [profile]: {
          agent: "claude",
          configDir: nativeA,
          defaultModel: model,
          modelAliases: { [model]: "opus" },
        },
      },
    });
    const initial = await launch(["new", "-m", "go", "--profile", profile]);
    expect(initial.code, initial.stderr).toBe(0);
    expect(newest().frontmatter).toMatchObject({ profile, model, status: "succeeded" });
    const status = await launch(["status", newest().path, "--result"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("done");
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(newest().frontmatter).toMatchObject({ profile, model, status: "succeeded" });
    expect(resumed.modelResolver).toHaveBeenCalledWith("claude", "opus", expect.anything());
  });

  it("rejects selected-profile failures before reserving a side ticket or discovering models", async () => {
    const result = await launch([
      "new",
      "--no-ticket",
      "--protocol",
      "spec",
      "-m",
      "go",
      "--profile",
      "missing",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing profile");
    expect(result.modelResolver).not.toHaveBeenCalled();
    expect(records()).toHaveLength(0);
    expect(existsSync(join(nativeA, "identity"))).toBe(false);
  });

  it("shares the finalized environment across discovery and spawn; records pre-expansion metadata", async () => {
    const result = await launch(["new", "-m", "go", "--profile", "a"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.modelResolver).toHaveBeenCalledWith("claude", "opus", {
      cwd: project,
      env: expect.objectContaining({
        CLAUDE_CONFIG_DIR: nativeA,
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
      }),
    });
    expect(observed()).toMatchObject({
      store: nativeA,
      keyPresent: false,
      parentPresent: false,
      ceiling: "0",
    });
    const file = newest();
    expect(file.frontmatter).toMatchObject({
      profile: "a",
      agent: "claude",
      model: "choice",
      sessionId: "native-session",
    });
    expect(file.frontmatter.command).toContain('--profile "a"');
    expect(readFileSync(file.path, "utf8")).not.toContain("fixture-secret");
    expect(env.TOKEN).toBe("fixture-secret");
    expect(env.CLAUDE_CODE_SESSION_ID).toBe("parent");
  });

  it("uses the project selection ahead of recorded/global settings and preserves the model with current aliases", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    writeFileSync(join(nativeB, "identity"), "native-session");
    writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "b" } } } });
    const result = await launch(["resume", "native-session", "-m", "more"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.modelResolver).toHaveBeenCalledWith("claude", "haiku", expect.anything());
    expect(observed().store).toBe(nativeB);
    expect(newest().frontmatter).toMatchObject({
      profile: "b",
      model: "choice",
      sessionId: "native-session",
    });
    expect(existsSync(join(home, ".alignfirst/companions/app"))).toBe(false);
  });

  it("keeps the recorded profile ahead of a changed global default", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    settings({ profile: "b" });
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(observed().store).toBe(nativeA);
    expect(newest().frontmatter.profile).toBe("a");
  });

  it("fails in an unavailable selected native home without falling back", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const failed = await launch(["resume", "native-session", "-m", "more", "--profile", "b"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('profile "b"');
    expect(failed.stderr).toContain(nativeB);
    expect(failed.stderr).toContain("No account fallback");
    expect(readCompletion(newest().path).frontmatter).toMatchObject({
      status: "failed",
      profile: "b",
      model: "choice",
      sessionId: "native-session",
      exitReason: "error",
    });
    const status = await launch(["status", newest().path, "--result"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("sessionId: native-session\n");
    expect(existsSync(join(nativeB, "identity"))).toBe(false);
  });

  it("rejects a replacement native conversation even after a successful final response", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    writeFileSync(join(nativeB, "identity"), "replacement-session");
    const failed = await launch(["resume", "native-session", "-m", "more", "--profile", "b"]);
    expect(failed.code).toBe(1);
    const completion = readCompletion(newest().path);
    expect(completion.result).toContain("identity changed");
    expect(completion.frontmatter).toMatchObject({
      status: "failed",
      profile: "b",
      model: "choice",
      sessionId: "native-session",
      exitReason: "error",
    });
    const status = await launch(["status", newest().path, "--result"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("sessionId: native-session\n");
  });

  it("validates cross-agent and retained-model changes before discovery or writing a run", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const before = records().length;
    const cross = await launch(["resume", "native-session", "-m", "more", "--profile", "pi"]);
    expect(cross.code).toBe(1);
    expect(cross.stderr).toContain("belongs to agent claude");
    expect(cross.modelResolver).not.toHaveBeenCalled();
    settings({
      profiles: {
        a: { agent: "claude", configDir: nativeA, models: ["sonnet"], defaultModel: "sonnet" },
      },
    });
    const disallowed = await launch(["resume", "native-session", "-m", "more"]);
    expect(disallowed.stderr).toContain("supply --model");
    expect(disallowed.modelResolver).not.toHaveBeenCalled();
    expect(records()).toHaveLength(before);
    expect(
      (await launch(["resume", "native-session", "-m", "more", "--model", "sonnet"])).code,
    ).toBe(0);
    expect(newest().frontmatter.model).toBe("sonnet");
  });

  it("preserves a recorded null model rather than applying the new-session default", async () => {
    settings({ profiles: { a: { agent: "claude", configDir: nativeA } } });
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    settings();
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.modelResolver).toHaveBeenCalledWith("claude", undefined, expect.anything());
    expect(observed().args).not.toContain("--model");
    expect(newest().frontmatter.model).toBeNull();
  });

  it.each([
    { profile: "dangling" },
    { defaultProfiles: { claude: "dangling" } },
    { defaultProfiles: {} },
    { profiles: { a: { agent: "claude", default: "invalid" } } },
    { profiles: { a: { agent: "claude", default: true }, b: { agent: "claude", default: true } } },
    { profiles: {} },
    { profiles: { a: { agent: "claude", defaultModel: "disallowed" } } },
  ])("reads terminal status despite launch-resolution failures %j", async (invalid) => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const file = newest().path;
    settings(invalid);
    const before = readFileSync(file, "utf8");
    const result = await launch(["status", file, "--result"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("profile: a");
    expect(result.stdout).toContain("done");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await launch(["status", "--help"])).code).toBe(0);
  });

  it.each(["explicit", "project"])(
    "requires %s replacement for a deleted recorded profile",
    async (replacement) => {
      expect((await launch(["new", "-m", "go"])).code).toBe(0);
      settings({
        profile: "b",
        profiles: { b: { agent: "claude", configDir: nativeA, modelAliases: { choice: "opus" } } },
      });
      expect((await launch(["resume", "native-session", "-m", "more"])).stderr).toContain(
        "missing profile",
      );
      if (replacement === "project")
        writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "b" } } } });
      const result = await launch([
        "resume",
        "native-session",
        "-m",
        "more",
        ...(replacement === "explicit" ? ["--profile", "b"] : []),
      ]);
      expect(result.code, result.stderr).toBe(0);
    },
  );
});
