import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { makeSink, writeSettings } from "../helpers.js";
import { type FakeAgent, installFakeAgent, quote, writeAlignfirstStub } from "../stand-ins.js";

let root: string;
let home: string;
let project: string;
let nativeA: string;
let nativeB: string;
let env: NodeJS.ProcessEnv;
let projectProfile: string | undefined;
let fake: FakeAgent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aligndev-profiles-"));
  home = join(root, "home");
  project = join(home, "app");
  nativeA = join(root, "native-a");
  nativeB = join(root, "native-b");
  projectProfile = undefined;
  mkdirSync(home);
  env = {
    HOME: home,
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    TOKEN: "fixture-secret",
    CLAUDE_CODE_SESSION_ID: "parent",
  };
  settings();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// A `claude` that keeps its conversation identity in the selected native store and records the
// environment facts the tests read through `observed()`.
function makeLaunchFixture(): void {
  mkdirSync(join(project, ".plans"), { recursive: true });
  mkdirSync(nativeA);
  mkdirSync(nativeB);
  fake = installFakeAgent(
    root,
    "claude",
    `store=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
mkdir -p "$store"
resume=
previous=
for arg in "$@"; do
  if [ "$previous" = --resume ]; then resume=$arg; fi
  previous=$arg
done
if [ -n "$resume" ]; then
  if [ ! -f "$store/identity" ]; then
    printf 'Conversation unavailable in selected native store.' >&2
    exit 1
  fi
  id=$(cat "$store/identity")
else
  id=native-session
  printf '%s' "$id" > "$store/identity"
fi
{
  printf 'store=%s\\n' "$store"
  printf 'directoryPresent=%s\\n' "\${CLAUDE_CONFIG_DIR+true}"
  printf 'keyPresent=%s\\n' "\${TOKEN+true}"
  printf 'parentPresent=%s\\n' "\${CLAUDE_CODE_SESSION_ID+true}"
  printf 'ceiling=%s\\n' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"
} > ${quote(join(root, "observed.txt"))}
printf '{"type":"system","subtype":"init","session_id":"%s"}\\n' "$id"
printf '{"type":"result","session_id":"%s","result":"done","is_error":false}\\n' "$id"`,
  );
}

function settings(extra: object = {}) {
  writeSettings(home, {
    code: {
      fallbackProfile: "a",
      profiles: {
        a: {
          harness: "claude",
          configDir: nativeA,
          defaultModel: "choice",
          modelAliases: { choice: "model-a" },
          unset: ["TOKEN"],
        },
        b: {
          harness: "claude",
          configDir: nativeB,
          defaultModel: "sonnet",
          modelAliases: { choice: "model-b" },
          unset: ["TOKEN"],
        },
        pi: { harness: "pi" },
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
    alignfirstCommand: stub(),
    stdout,
    stderr,
    modelResolver,
    quotaReader,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), modelResolver };
}

// The alignfirst stand-in reports `projectProfile` as the project's selection.
function stub(): string[] {
  const aligndev = projectProfile === undefined ? undefined : { profile: projectProfile };
  return writeAlignfirstStub(root, project, { aligndev }).command;
}

function records() {
  return listSessionRecords(join(project, ".plans"), readMachineId(home));
}

function newest() {
  return records().reduce((a, b) => (a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b));
}

function observed() {
  const lines = readFileSync(join(root, "observed.txt"), "utf8").trimEnd().split("\n");
  const values = Object.fromEntries(lines.map((line) => line.split(/=(.*)/s, 2)));
  return {
    args: fake.received().args,
    store: values.store,
    directoryPresent: values.directoryPresent === "true",
    keyPresent: values.keyPresent === "true",
    parentPresent: values.parentPresent === "true",
    ceiling: values.ceiling,
  };
}

describe("independent quota configuration", () => {
  it("uses each native profile's finalized coding environment when quota is omitted", () => {
    const config = loadConfig(home, "alignfirst");
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

  it("keeps explicit quota omitted/null/string selection independent of coding resets", () => {
    const caller = Object.freeze({
      ...env,
      CLAUDE_CONFIG_DIR: nativeB,
      CODEX_HOME: nativeB,
      REMOVE_QUOTA: "remove",
    });
    for (const configDir of [undefined, null, nativeA]) {
      settings({
        profiles: {
          a: {
            harness: "claude",
            configDir: configDir === null ? nativeA : null,
            unset: ["TOKEN"],
            env: { CODING_ONLY: "coding" },
            quota: {
              source: "claude",
              configDir,
              env: { QUOTA_ONLY: "quota" },
              unset: ["REMOVE_QUOTA"],
            },
          },
        },
      });
      const config = loadConfig(home, "alignfirst");
      const before = JSON.stringify(config);
      const code = resolveCodeConfig(config, caller);
      const quota = resolveQuotaConfig(code, caller);
      if (quota.source === "none") throw new Error("unexpected disabled quota");
      expect(quota.source).toBe("claude");
      expect(quota.env.CLAUDE_CONFIG_DIR).toBe(
        configDir === null ? undefined : configDir === undefined ? nativeB : nativeA,
      );
      if (configDir === null) expect(Object.hasOwn(quota.env, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(quota.env).toMatchObject({
        HOME: home,
        TOKEN: "fixture-secret",
        QUOTA_ONLY: "quota",
        CODEX_HOME: nativeB,
      });
      for (const key of ["CODING_ONLY", "REMOVE_QUOTA", "CLAUDE_CODE_SESSION_ID"])
        expect(quota.env[key]).toBeUndefined();
      expect(code.childEnv.CLAUDE_CONFIG_DIR).toBe(configDir === null ? nativeA : undefined);
      expect(code.childEnv.QUOTA_ONLY).toBeUndefined();
      expect(code.childEnv.REMOVE_QUOTA).toBe("remove");
      expect(JSON.stringify(config)).toBe(before);
    }
  });

  it("routes quota to its selected source without changing the child environment", async () => {
    makeLaunchFixture();
    settings({
      profiles: {
        a: {
          harness: "pi",
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
    expect(result.stdout).toContain("Codex quota\n5 hours: 15% used");
    expect(result.stdout).not.toContain("fixture-secret");
    expect(
      resolveCodeConfig(loadConfig(home, "alignfirst"), env).childEnv.PI_CODING_AGENT_DIR,
    ).toBe(nativeA);
    expect(records()).toHaveLength(0);
  });

  it.each([undefined, { source: "none" }])(
    "spawns nothing for unsupported/disabled quota %j",
    async (quota) => {
      makeLaunchFixture();
      settings({ profiles: { a: { harness: "pi", quota } } });
      const reader = vi.fn(async () => "must not run");
      const result = await launch(["quota"], undefined, reader);
      expect(result.code).toBe(1);
      expect(reader).not.toHaveBeenCalled();
      expect(result.modelResolver).not.toHaveBeenCalled();
    },
  );

  it("uses new-session project/explicit precedence rather than a recorded run's profile", async () => {
    makeLaunchFixture();
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    settings({ fallbackProfile: "b" });
    const reader = vi.fn(async () => "limits");
    expect((await launch(["quota"], undefined, reader)).code).toBe(0);
    projectProfile = "a";
    expect((await launch(["quota"], undefined, reader)).code).toBe(0);
    expect((await launch(["quota", "--profile", "b"], undefined, reader)).code).toBe(0);
    for (const [index, nativeHome] of [nativeB, nativeA, nativeB].entries()) {
      expect(reader).toHaveBeenNthCalledWith(index + 1, "claude", {
        cwd: project,
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: nativeHome }),
      });
    }
  });
});

describe("effective profiles through CLI launch and resume", () => {
  beforeEach(makeLaunchFixture);

  it("records the assistant's profile and keeps it on resume after the defaults change", async () => {
    const profiles = loadConfig(home, "alignfirst").code.profiles;
    settings({ fallbackProfile: undefined, profiles: { a: { ...profiles?.a, default: true } } });
    env.CLAUDECODE = "1";
    env.CLAUDE_CONFIG_DIR = nativeA;
    const initial = await launch(["new", "-m", "go"]);
    expect(initial.code, initial.stderr).toBe(0);
    expect(newest().frontmatter).toMatchObject({ profile: "a", model: "choice" });
    expect(observed()).toMatchObject({ store: nativeA, keyPresent: false });
    expect(initial.modelResolver).toHaveBeenCalledWith("claude", "model-a", expect.anything());
    settings({
      fallbackProfile: "b",
      profiles: {
        a: { ...profiles?.a, default: false },
        b: { ...profiles?.b, default: true },
      },
    });
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(newest().frontmatter.profile).toBe("a");
    expect(observed().store).toBe(nativeA);
  });

  it("keeps a historical run without a profile on built-ins despite configured profiles", async () => {
    settings({ profiles: { a: { harness: "claude", configDir: nativeA } } });
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const historical = newest().path;
    const bytes = readFileSync(historical, "utf8").replace(/^profile: a\n/m, "");
    writeFileSync(historical, bytes);
    settings({
      fallbackProfile: undefined,
      profiles: {
        a: {
          harness: "claude",
          configDir: nativeB,
          default: true,
          defaultModel: "opus",
          unset: ["TOKEN"],
        },
        b: { harness: "claude", configDir: nativeB },
      },
    });
    env.CLAUDECODE = "1";
    env.CLAUDE_CONFIG_DIR = nativeA;
    const resumed = await launch(["resume", "native-session", "-m", "more"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(newest().frontmatter).toMatchObject({ profile: null, model: null, agent: "claude" });
    expect(observed()).toMatchObject({ store: nativeA, keyPresent: true });
    expect(observed().args).not.toContain("--model");
    expect(readFileSync(historical, "utf8")).toBe(bytes);
  });

  it("redacts profile environment values in help and guide", async () => {
    settings({
      profiles: {
        a: {
          harness: "claude",
          env: { CLAUDE_CONFIG_DIR: "private-store-value", HOME: "private-home-value" },
        },
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
      alignfirstCommand: stub(),
      stdout,
      stderr,
    });
    expect(help.code, help.stderr).toBe(0);
    expect(guideCode, stderr.text()).toBe(0);
    for (const text of [help.stdout, stdout.text()]) {
      expect(text).not.toContain("private-store-value");
      expect(text).not.toContain("private-home-value");
    }
  });

  it("keeps the initial identity and model-discovery failure metadata of a resume", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const originalFile = newest().path;
    const original = readFileSync(originalFile, "utf8");
    const initialMetadata: SessionFrontmatter[] = [];
    const modelResolver = vi.fn(async () => {
      initialMetadata.push(newest().frontmatter);
      throw new Error("fixture model discovery failure");
    });
    const failed = await launch(
      ["resume", "native-session", "-m", "go", "--profile", "b"],
      modelResolver,
    );
    expect(failed.code).toBe(1);
    expect(modelResolver).toHaveBeenCalledOnce();
    expect(initialMetadata).toEqual([
      expect.objectContaining({ status: "running", profile: "b", sessionId: "native-session" }),
    ]);
    expect(readCompletion(newest().path).frontmatter).toMatchObject({
      status: "failed",
      profile: "b",
      model: "choice",
      sessionId: "native-session",
      exitReason: "error",
    });
    expect(readFileSync(originalFile, "utf8")).toBe(original);
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
    expect(result.modelResolver).not.toHaveBeenCalled();
    expect(records()).toHaveLength(0);
    expect(readFileSync(join(root, "alignfirst.log"), "utf8")).not.toContain("--side");
  });

  it("shares the finalized environment across discovery and spawn; records pre-expansion metadata", async () => {
    const result = await launch(["new", "-m", "go", "--profile", "a"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.modelResolver).toHaveBeenCalledWith("claude", "model-a", {
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
    projectProfile = "b";
    const result = await launch(["resume", "native-session", "-m", "more"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.modelResolver).toHaveBeenCalledWith("claude", "model-b", expect.anything());
    expect(observed().store).toBe(nativeB);
    expect(newest().frontmatter).toMatchObject({
      profile: "b",
      model: "choice",
      sessionId: "native-session",
    });
  });

  it("validates cross-agent and retained-model changes before discovery or writing a run", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const before = records().length;
    const cross = await launch(["resume", "native-session", "-m", "more", "--profile", "pi"]);
    expect(cross.code).toBe(1);
    expect(cross.modelResolver).not.toHaveBeenCalled();
    settings({
      profiles: {
        a: { harness: "claude", configDir: nativeA, models: ["sonnet"], defaultModel: "sonnet" },
      },
    });
    const disallowed = await launch(["resume", "native-session", "-m", "more"]);
    expect(disallowed.code).toBe(1);
    expect(disallowed.modelResolver).not.toHaveBeenCalled();
    expect(records()).toHaveLength(before);
    expect(
      (await launch(["resume", "native-session", "-m", "more", "--model", "sonnet"])).code,
    ).toBe(0);
    expect(newest().frontmatter.model).toBe("sonnet");
  });

  it.each(["explicit", "project"])(
    "requires %s replacement for a deleted recorded profile",
    async (replacement) => {
      expect((await launch(["new", "-m", "go"])).code).toBe(0);
      settings({
        fallbackProfile: "b",
        profiles: {
          b: { harness: "claude", configDir: nativeA, modelAliases: { choice: "model-a" } },
        },
      });
      expect((await launch(["resume", "native-session", "-m", "more"])).code).toBe(1);
      expect(records()).toHaveLength(1);
      if (replacement === "project") projectProfile = "b";
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
