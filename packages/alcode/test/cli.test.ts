import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRunConfig,
  checkLaunchGuards,
  main,
  parseAlcodeArgs,
  resolveTicket,
  type SessionArgs,
  validateSessionArgs,
} from "../src/cli.js";
import { CLAUDE_DEFAULT_MODELS } from "../src/models.js";
import {
  type SessionFrontmatter,
  type SessionRecord,
  listSessionRecords,
  readCompletion,
  writeInitialSessionFile,
} from "../src/session-file.js";

const ALIGNFIRST_BIN = fileURLToPath(
  new URL("../../alignfirst/bin/alignfirst.mjs", import.meta.url),
);

function parse(tokens: string[]): SessionArgs {
  const command = parseAlcodeArgs(["node", "alcode", ...tokens]);
  if (command.kind !== "session")
    throw new Error(`expected a session command, got ${command.kind}`);
  return command.args;
}

function validate(
  tokens: string[],
  models: readonly string[] = CLAUDE_DEFAULT_MODELS,
): string | undefined {
  return validateSessionArgs(parse(tokens), models);
}

function makeSink(): { write(text: string): void; text(): string } {
  let buffer = "";
  return {
    write(text: string) {
      buffer += text;
    },
    text: () => buffer,
  };
}

describe("coding-agent selection", () => {
  it("keeps --version agent-independent", async () => {
    const stdout = makeSink();
    expect(await main({ argv: ["node", "alcode", "--version"], env: {}, stdout })).toBe(0);
    expect(stdout.text()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("rejects missing and invalid selectors before help", async () => {
    for (const env of [{}, { ALIGNFIRST_CODE_AGENT: "other" }]) {
      const stderr = makeSink();
      expect(await main({ argv: ["node", "alcode", "--help"], env, stderr })).toBe(1);
      expect(stderr.text()).toContain("claude, codex");
    }
  });

  it("renders only the selected agent's models without discovery", async () => {
    const stdout = makeSink();
    const modelResolver = async () => {
      throw new Error("help must not discover models");
    };
    expect(
      await main({
        argv: ["node", "alcode", "--help"],
        env: { ALIGNFIRST_CODE_AGENT: "codex" },
        stdout,
        modelResolver,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("sol, terra, luna");
    expect(stdout.text()).toContain("alcode projects (list | doctor | status");
    expect(stdout.text()).not.toContain("reserve-side-ticket");
    expect(stdout.text()).not.toContain("fable");
  });
});

describe("parseAlcodeArgs", () => {
  it("maps the top-level flags to commands", () => {
    expect(parseAlcodeArgs(["node", "alcode", "--help"])).toEqual({ kind: "help" });
    expect(parseAlcodeArgs(["node", "alcode", "-h"])).toEqual({ kind: "help" });
    expect(parseAlcodeArgs(["node", "alcode", "--version"])).toEqual({ kind: "version" });
    expect(parseAlcodeArgs(["node", "alcode", "-v"])).toEqual({ kind: "version" });
    expect(parseAlcodeArgs(["node", "alcode", "--guide"])).toEqual({
      kind: "guide",
      variant: "generic",
    });
    expect(parseAlcodeArgs(["node", "alcode", "--openclaw-guide"])).toEqual({
      kind: "guide",
      variant: "openclaw",
    });
    expect(parseAlcodeArgs(["node", "alcode", "status", ".plans/1/_alcode/run.md"])).toEqual({
      kind: "status",
      sessionFile: ".plans/1/_alcode/run.md",
    });
    expect(parseAlcodeArgs(["node", "alcode", "usage"])).toEqual({ kind: "usage" });
  });

  it("reads `new` options into camelCase fields", () => {
    const args = parse(["new", "--protocol", "aad", "--ticket", "29", "--message", "go"]);
    expect(args.resume).toBeUndefined();
    expect(args.protocol).toBe("aad");
    expect(args.ticket).toBe("29");
    expect(args.noTicket).toBe(false);
    expect(args.message).toBe("go");
  });

  it("reads `resume <sessionId>`", () => {
    const args = parse(["resume", "abc", "--protocol", "plan"]);
    expect(args.resume).toBe("abc");
    expect(args.protocol).toBe("plan");
  });

  it("accepts -m as the short form of --message", () => {
    expect(parse(["new", "-m", "go"]).message).toBe("go");
  });

  it("reads --no-ticket on `new` only", () => {
    expect(parse(["new", "--no-ticket", "--protocol", "aad", "-m", "go"]).noTicket).toBe(true);
    expect(() => parse(["resume", "abc", "--no-ticket"])).toThrow();
  });

  it("reads --meta as an opaque string and leaves it undefined when omitted", () => {
    expect(parse(["new", "--message", "go", "--meta", "thread:room/abc.def"]).meta).toBe(
      "thread:room/abc.def",
    );
    expect(parse(["new", "--message", "go"]).meta).toBeUndefined();
  });

  it("renders help after a command", () => {
    expect(parseAlcodeArgs(["node", "alcode", "new", "--help"])).toEqual({ kind: "help" });
    expect(parseAlcodeArgs(["node", "alcode", "resume", "-h"])).toEqual({ kind: "help" });
    expect(parseAlcodeArgs(["node", "alcode", "status", "--help"])).toEqual({ kind: "help" });
    expect(parseAlcodeArgs(["node", "alcode", "usage", "--help"])).toEqual({ kind: "help" });
  });

  it("rejects a missing or unknown command", () => {
    expect(() => parseAlcodeArgs(["node", "alcode"])).toThrow("no command given");
    expect(() => parseAlcodeArgs(["node", "alcode", "spec"])).toThrow('unknown command "spec"');
    expect(() => parseAlcodeArgs(["node", "alcode", "--new"])).toThrow('unknown command "--new"');
  });

  it("rejects unknown options, stray positionals, and a resume without an id", () => {
    expect(() => parse(["new", "--nope"])).toThrow();
    expect(() => parse(["new", "extra", "-m", "go"])).toThrow();
    expect(() => parseAlcodeArgs(["node", "alcode", "status"])).toThrow(
      "exactly one <session-file>",
    );
    expect(() => parse(["status", "--message", "go"])).toThrow();
    expect(() => parse(["usage", "extra"])).toThrow();
    expect(() => parse(["resume", "--message", "go"])).toThrow("exactly one <sessionId>");
    expect(() => parse(["resume", "a", "b", "--message", "go"])).toThrow("exactly one <sessionId>");
  });
});

describe("validateSessionArgs", () => {
  it("rejects an unknown protocol", () => {
    expect(validate(["new", "--protocol", "bogus", "--ticket", "1"])).toBe(
      "Error: --protocol must be one of: spec, plan, aad, description, catchup, review, merge.",
    );
  });

  it("rejects a model outside the allowlist", () => {
    expect(validate(["new", "--message", "go", "--model", "claude-opus-5"])).toBe(
      "Error: --model must be one of: fable, opus, sonnet, haiku.",
    );
  });

  it("accepts an allowlisted model, on new and on resume", () => {
    expect(validate(["new", "--message", "go", "--model", "opus"])).toBe(undefined);
    expect(validate(["resume", "s", "--message", "m", "--model", "haiku"])).toBe(undefined);
  });

  it("validates against the host's model list when one is configured", () => {
    const models = ["sonnet", "haiku"];
    expect(validate(["new", "--message", "go", "--model", "sonnet"], models)).toBe(undefined);
    expect(validate(["new", "--message", "go", "--model", "opus"], models)).toBe(
      "Error: --model must be one of: sonnet, haiku.",
    );
  });

  it("requires --message when no protocol", () => {
    expect(validate(["new"])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
    expect(validate(["resume", "s"])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
    expect(validate(["new", "--message", ""])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
    expect(validate(["new", "--message", "   "])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
  });

  it("requires --ticket or --no-ticket with `new --protocol`", () => {
    expect(validate(["new", "--protocol", "plan"])).toBe(
      "Error: --ticket or --no-ticket is required with `new --protocol`.",
    );
    expect(validate(["new", "--protocol", "plan", "--ticket", "1"])).toBeUndefined();
    expect(validate(["new", "--protocol", "plan", "--no-ticket"])).toBeUndefined();
  });

  it("rejects --no-ticket with --ticket or without a protocol", () => {
    expect(validate(["new", "--protocol", "plan", "--ticket", "1", "--no-ticket"])).toBe(
      "Error: --ticket and --no-ticket are mutually exclusive.",
    );
    expect(validate(["new", "--no-ticket", "-m", "go"])).toBe(
      "Error: --no-ticket requires --protocol.",
    );
  });

  it("requires --message for spec and aad", () => {
    expect(validate(["new", "--protocol", "spec", "--ticket", "1"])).toBe(
      "Error: --protocol spec requires --message.",
    );
    expect(validate(["new", "--protocol", "aad", "--no-ticket"])).toBe(
      "Error: --protocol aad requires --message.",
    );
    expect(validate(["new", "--protocol", "spec", "--ticket", "1", "--message", ""])).toBe(
      "Error: --protocol spec requires --message.",
    );
    expect(validate(["new", "--protocol", "aad", "--no-ticket", "--message", "\t"])).toBe(
      "Error: --protocol aad requires --message.",
    );
  });

  it("accepts a resume with a protocol and no ticket, and --ticket as an explicit override", () => {
    expect(validate(["resume", "s", "--protocol", "plan"])).toBeUndefined();
    expect(validate(["resume", "s", "--ticket", "1", "--message", "m"])).toBeUndefined();
  });

  it("accepts a non-numeric ticket format (consumer repos vary)", () => {
    expect(validate(["new", "--protocol", "plan", "--ticket", "AB-123_x.4"])).toBeUndefined();
  });

  it("rejects a ticket with a path separator or traversal", () => {
    const expected =
      "Error: --ticket must be a single path segment " +
      "(letters, digits, '.', '-', '_'); no path separators or '..'.";
    expect(validate(["new", "--protocol", "plan", "--ticket", "../../etc"])).toBe(expected);
    expect(validate(["new", "--protocol", "plan", "--ticket", "a/b"])).toBe(expected);
    expect(validate(["new", "--protocol", "plan", "--ticket", ".."])).toBe(expected);
    expect(validate(["resume", "s", "--ticket", "a/b", "--message", "m"])).toBe(expected);
  });
});

describe("status", () => {
  let dir: string;
  let sessionFilePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-status-"));
    sessionFilePath = join(dir, ".plans", "1", "_alcode", "run.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeStatusRecord(pid: number): void {
    writeInitialSessionFile(sessionFilePath, {
      status: "running",
      agent: "claude",
      protocol: "review",
      ticket: "1",
      model: null,
      sessionId: "sess-42",
      command: "alcode new --protocol review --ticket 1",
      meta: null,
      pid,
      pidStartTime: null,
      cwd: dir,
      startedAt: "2026-08-29T11:55:29.000Z",
      endedAt: null,
      exitReason: null,
    });
  }

  it("reconciles and reports a dead run without a coding agent", async () => {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    writeStatusRecord(child.pid);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "alcode", "status", ".plans/1/_alcode/run.md"],
        cwd: dir,
        env: {},
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain(
      "sessionFile: .plans/1/_alcode/run.md\nsessionId: sess-42\nstatus: failed\n",
    );
    expect(stdout.text()).toContain("exitReason: terminated\n");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("reports a live run without changing its record", async () => {
    writeStatusRecord(process.pid);
    const stdout = makeSink();
    expect(
      await main({
        argv: ["node", "alcode", "status", ".plans/1/_alcode/run.md"],
        cwd: dir,
        env: {},
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("status: running\n");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("running");
  });

  it("rejects files outside the session-record tree", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "alcode", "status", "notes.md"],
        cwd: dir,
        env: {},
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("session file under .plans/**/_alcode/*.md");
  });

  it("reports a missing session file in its own words", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "alcode", "status", ".plans/1/_alcode/run.md"],
        cwd: dir,
        env: {},
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("Error: session file not found: .plans/1/_alcode/run.md\n");
  });

  it("rejects a session-path symlink that resolves outside .plans", async () => {
    mkdirSync(join(dir, ".plans", "1", "_alcode"), { recursive: true });
    const outsidePath = join(dir, "outside.md");
    writeFileSync(outsidePath, "keep me");
    symlinkSync(outsidePath, sessionFilePath);
    const stderr = makeSink();

    expect(
      await main({
        argv: ["node", "alcode", "status", ".plans/1/_alcode/run.md"],
        cwd: dir,
        env: {},
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("resolves outside");
  });
});

describe("usage", () => {
  it("reads usage without a plans directory or model discovery", async () => {
    const stdout = makeSink();
    const modelResolver = vi.fn(async () => {
      throw new Error("usage must not discover models");
    });
    const usageReader = vi.fn(async () => "Claude Code usage\n\nCurrent session: 25% used");

    expect(
      await main({
        argv: ["node", "alcode", "usage"],
        cwd: tmpdir(),
        env: { ALIGNFIRST_CODE_AGENT: "claude" },
        stdout,
        modelResolver,
        usageReader,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe("Claude Code usage\n\nCurrent session: 25% used\n");
    expect(usageReader).toHaveBeenCalledWith("claude", {
      cwd: tmpdir(),
      env: { ALIGNFIRST_CODE_AGENT: "claude" },
    });
    expect(modelResolver).not.toHaveBeenCalled();
  });

  it("reports usage failures", async () => {
    const stderr = makeSink();
    const usageReader = async () => {
      throw new Error("limits unavailable");
    };
    expect(
      await main({
        argv: ["node", "alcode", "usage"],
        env: { ALIGNFIRST_CODE_AGENT: "codex" },
        stderr,
        usageReader,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("limits unavailable\n");
  });
});

describe("resolveTicket", () => {
  function record(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return {
      path: "/proj/.plans/30/_alcode/r.md",
      frontmatter: {
        status: "succeeded",
        agent: "claude",
        protocol: "spec",
        ticket: "30",
        model: null,
        sessionId: "abc",
        command: "alcode new --protocol spec --ticket 30 --message go",
        meta: null,
        pid: null,
        pidStartTime: null,
        cwd: "/proj",
        startedAt: "2026-07-01T09:15:03.000Z",
        endedAt: null,
        exitReason: null,
        ...overrides,
      },
    };
  }

  it("prefers the explicit --ticket over resume inheritance and message inference", () => {
    const withResume = parse(["resume", "abc", "--ticket", "9", "--message", "m"]);
    expect(resolveTicket(withResume, [record({})])).toBe("9");

    const withMessage = parse(["new", "--ticket", "9", "--message", "See .plans/2/B2-plan.md"]);
    expect(resolveTicket(withMessage, [])).toBe("9");
  });

  it("resume inherits the latest non-null ticket among the session's records", () => {
    const records = [
      record({ ticket: "30", startedAt: "2026-07-01T09:00:00.000Z" }),
      record({ ticket: "31", startedAt: "2026-07-01T10:00:00.000Z" }),
      record({ ticket: null, startedAt: "2026-07-01T11:00:00.000Z" }),
      record({ ticket: "99", sessionId: "other", startedAt: "2026-07-01T12:00:00.000Z" }),
    ];
    expect(resolveTicket(parse(["resume", "abc", "--message", "m"]), records)).toBe("31");
  });

  it("resume without any ticketed record yields no ticket", () => {
    const records = [record({ ticket: null })];
    expect(resolveTicket(parse(["resume", "abc", "--message", "m"]), records)).toBeUndefined();
  });

  it("infers the ticket from a .plans/<ticket>/ path in the message", () => {
    const parsed = parse(["new", "--message", "Execute the plan: .plans/2/B2-plan.md"]);
    expect(resolveTicket(parsed, [])).toBe("2");
  });

  it("ignores _-prefixed segments such as _alcode", () => {
    const parsed = parse(["new", "--message", "See .plans/_alcode/20260706-122913.md"]);
    expect(resolveTicket(parsed, [])).toBeUndefined();
  });

  it("falls back to no ticket on conflicting inferred segments", () => {
    const parsed = parse(["new", "--message", "Compare .plans/2/a.md with .plans/3/b.md"]);
    expect(resolveTicket(parsed, [])).toBeUndefined();

    const repeated = parse(["new", "--message", "Read .plans/2/a.md then .plans/2/b.md"]);
    expect(resolveTicket(repeated, [])).toBe("2");
  });

  it("yields no ticket for a new run without a message", () => {
    expect(resolveTicket(parse(["new"]), [])).toBeUndefined();
  });
});

describe("buildRunConfig", () => {
  it("threads the caller env into the config so the child inherits the same source", () => {
    const parsed = parse(["new", "--message", "go"]);
    const env = { FOO: "bar", ALIGNFIRST_CODE_SKIP_PERMISSIONS: "1", ALIGNFIRST_CODE_UNSET: "X,Y" };
    const config = buildRunConfig(
      parsed,
      undefined,
      "/proj",
      "/proj/.plans/_alcode/s.md",
      env,
      undefined,
    );
    expect(config.env).toBe(env);
    expect(config.executableModel).toBeUndefined();
    expect(config.skipPermissions).toBe(true);
    expect(config.unset).toEqual(["X", "Y"]);
    expect(config.resume).toBeUndefined();
  });

  it("puts the effective ticket, not the flag, in the prompt", () => {
    const parsed = parse(["resume", "abc", "--protocol", "plan"]);
    const config = buildRunConfig(
      parsed,
      "30",
      "/proj",
      "/proj/.plans/30/_alcode/s.md",
      {},
      undefined,
    );
    expect(config.prompt).toBe(
      "Run `alignfirst guide plan` and follow the protocol. Ticket ID = 30.",
    );
    expect(config.resume).toBe("abc");
  });
});

describe("launch guards", () => {
  let dir: string;
  let realCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-guards-"));
    mkdirSync(join(dir, ".plans"));
    realCwd = realpathSync(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeFrontmatter(overrides?: Partial<SessionFrontmatter>): SessionFrontmatter {
    return {
      status: "running",
      agent: "claude",
      protocol: "spec",
      ticket: "30",
      model: null,
      sessionId: null,
      command: "alcode new --protocol spec --ticket 30 --message go",
      meta: null,
      pid: process.pid,
      pidStartTime: null,
      cwd: realCwd,
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
      ...overrides,
    };
  }

  function seedRecord(name: string, overrides: Partial<SessionFrontmatter>): void {
    writeInitialSessionFile(join(dir, ".plans", "30", "_alcode", name), makeFrontmatter(overrides));
  }

  async function run(tokens: string[]): Promise<{ code: number; stderr: string }> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "alcode", ...tokens],
      stdout,
      stderr,
      cwd: dir,
      env: { ALIGNFIRST_CODE_AGENT: "claude" },
    });
    return { code, stderr: stderr.text() };
  }

  it("rejects an unknown resume id and lists the known recent sessions", async () => {
    seedRecord("a.md", {
      status: "succeeded",
      sessionId: "aaa",
      startedAt: "2026-07-01T09:00:00.000Z",
    });
    seedRecord("b.md", {
      status: "failed",
      sessionId: "bbb",
      startedAt: "2026-07-01T10:00:00.000Z",
    });
    const { code, stderr } = await run(["resume", "zzz", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown session id zzz");
    expect(stderr.indexOf("bbb")).toBeLessThan(stderr.indexOf("aaa")); // most recent first
    expect(stderr).toContain("ticket 30");
  });

  it("says plainly when no session records exist at all", async () => {
    const { code, stderr } = await run(["resume", "zzz", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no session records exist");
  });

  it("rejects resuming a session that is still running", async () => {
    seedRecord("running.md", { sessionId: "abc" });
    const { code, stderr } = await run(["resume", "abc", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`session abc is still running (pid ${process.pid})`);
  });

  it("rejects legacy and cross-agent resumes", () => {
    const parsed = parse(["resume", "abc", "--message", "continue"]);
    const legacy = [
      {
        path: "legacy.md",
        frontmatter: makeFrontmatter({ status: "succeeded", sessionId: "abc", agent: null }),
      },
    ];
    expect(checkLaunchGuards(parsed, "claude", realCwd, legacy)).toContain(
      "predates agent-aware sessions",
    );

    const codex = [
      {
        path: "codex.md",
        frontmatter: makeFrontmatter({ status: "succeeded", sessionId: "abc", agent: "codex" }),
      },
    ];
    const mismatch = checkLaunchGuards(parsed, "claude", realCwd, codex);
    expect(mismatch).toContain("belongs to agent codex");
    expect(mismatch).toContain("selected agent is claude");
  });

  it("rejects a cross-agent resume before discovery or session creation", async () => {
    seedRecord("codex.md", { status: "succeeded", sessionId: "abc", agent: "codex" });
    const before = listSessionRecords(dir).length;
    const modelResolver = vi.fn(async () => "gpt-5.6-terra");
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "alcode", "resume", "abc", "--message", "go", "--model", "terra"],
      cwd: dir,
      env: { ALIGNFIRST_CODE_AGENT: "claude", ALIGNFIRST_CODE_MODELS: "terra" },
      stderr,
      modelResolver,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("belongs to agent codex");
    expect(modelResolver).not.toHaveBeenCalled();
    expect(listSessionRecords(dir)).toHaveLength(before);
  });

  it("seals model-discovery failures in the session file", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "alcode", "new", "--message", "go", "--model", "terra"],
      cwd: dir,
      env: { ALIGNFIRST_CODE_AGENT: "codex" },
      stdout,
      stderr,
      modelResolver: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toContain("Session file:");
    expect(stderr.text()).toContain("catalog unavailable");
    const records = listSessionRecords(dir);
    expect(records).toHaveLength(1);
    expect(readCompletion(records[0].path)).toMatchObject({
      frontmatter: { status: "failed", exitReason: "error", sessionId: null },
      result: "catalog unavailable",
    });
  });

  it("reserves the next side ticket through alignfirst for --no-ticket", async () => {
    mkdirSync(join(dir, ".plans", "side-1"));
    const stdout = makeSink();
    const code = await main({
      argv: ["node", "alcode", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      cwd: dir,
      env: { ALIGNFIRST_CODE_AGENT: "claude" },
      stdout,
      stderr: makeSink(),
      alignfirstCommand: ["node", ALIGNFIRST_BIN],
      modelResolver: async () => {
        throw new Error("stop before spawning");
      },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toContain(`Session file: ${join(".plans", "side-2", "_alcode")}`);
    const [record] = listSessionRecords(dir);
    expect(record.frontmatter.ticket).toBe("side-2");
    expect(record.frontmatter.command).toBe('alcode new --protocol aad --no-ticket --message "go"');
  });

  it("reports a missing alignfirst executable before writing a session file", async () => {
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "alcode", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      cwd: dir,
      env: { ALIGNFIRST_CODE_AGENT: "claude" },
      stderr,
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain("alignfirst is not installed");
    expect(listSessionRecords(dir)).toEqual([]);
  });

  it("rejects a protocol run while another run is active in the same worktree", async () => {
    seedRecord("running.md", { sessionId: "abc" });
    const { code, stderr } = await run(["new", "--protocol", "plan", "--ticket", "31"]);
    expect(code).toBe(1);
    expect(stderr).toContain("a protocol run is already active in this worktree");
    expect(stderr).toContain(`pid ${process.pid}`);
  });

  it("allows a protocol run when the active run sits in another worktree", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "31"]);
    const records = [
      {
        path: "/elsewhere/.plans/30/_alcode/r.md",
        frontmatter: makeFrontmatter({ sessionId: "abc", cwd: "/elsewhere" }),
      },
    ];
    expect(checkLaunchGuards(parsed, "claude", realCwd, records)).toBeUndefined();
  });

  it("exempts no-protocol invocations from the busy-worktree guard", () => {
    const records = [
      {
        path: join(dir, ".plans", "30", "_alcode", "r.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc" }),
      },
      // A resumable (finished) record so only the busy-worktree guard is in play.
      {
        path: join(dir, ".plans", "30", "_alcode", "done.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc2", status: "succeeded" }),
      },
    ];
    const answer = parse(["resume", "abc2", "--message", "answer"]);
    expect(checkLaunchGuards(answer, "claude", realCwd, records)).toBeUndefined();

    const execute = parse(["new", "--message", "Execute the plan"]);
    expect(checkLaunchGuards(execute, "claude", realCwd, records)).toBeUndefined();
  });
});
