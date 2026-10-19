import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { listSessionRecords, readCompletion } from "../../src/code/session-file.js";
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
const store = process.env.CLAUDE_CONFIG_DIR;
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
  args, store, keyPresent: process.env.TOKEN !== undefined,
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
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), modelResolver };
}

function records() {
  return listSessionRecords(join(project, ".plans"));
}

function newest() {
  return records().reduce((a, b) => (a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b));
}

function observed() {
  return JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
}

describe("effective profiles through CLI launch and resume", () => {
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
    expect(readCompletion(newest().path).frontmatter.status).toBe("failed");
    expect(existsSync(join(nativeB, "identity"))).toBe(false);
  });

  it("rejects a replacement native conversation even after a successful final response", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    writeFileSync(join(nativeB, "identity"), "replacement-session");
    const failed = await launch(["resume", "native-session", "-m", "more", "--profile", "b"]);
    expect(failed.code).toBe(1);
    const completion = readCompletion(newest().path);
    expect(completion.result).toContain("identity changed");
    expect(completion.frontmatter.sessionId).not.toBe("replacement-session");
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
    { defaultProfiles: { claude: "pi" } },
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
  });

  it("requires a replacement for a deleted recorded profile unless project/explicit selection overrides it", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    settings({
      profile: "b",
      profiles: { b: { agent: "claude", configDir: nativeA, modelAliases: { choice: "opus" } } },
    });
    expect((await launch(["resume", "native-session", "-m", "more"])).stderr).toContain(
      "missing profile",
    );
    const result = await launch(["resume", "native-session", "-m", "more", "--profile", "b"]);
    expect(result.code, result.stderr).toBe(0);
  });
});
