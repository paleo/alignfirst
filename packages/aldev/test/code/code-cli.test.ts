import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import {
  buildRunConfig,
  checkLaunchGuards,
  parseCodeArgs,
  type RunInput,
  resolveTicket,
  type SessionArgs,
  validateSessionArgs,
} from "../../src/code/code-cli.js";
import { CLAUDE_DEFAULT_MODELS } from "../../src/code/models.js";
import {
  type SessionFrontmatter,
  type SessionRecord,
  listSessionRecords,
  readCompletion,
  writeInitialSessionFile,
} from "../../src/code/session-file.js";
import type { CodeConfig } from "../../src/config.js";
import type { RunConfig } from "../../src/code/run-agent.js";
import type { ItemLocation, ItemName, ProjectReport } from "../../src/project/layout.js";
import {
  ALIGNFIRST_BIN,
  type CompanionProject,
  makeCompanionProject,
  makeSink,
  writeConfig,
} from "../helpers.js";

const ALIGNFIRST = [process.execPath, ALIGNFIRST_BIN];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parse(tokens: string[]): SessionArgs {
  const command = parseCodeArgs(tokens, "aldev");
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

function makeHome(config?: object): string {
  const home = mkdtempSync(join(tmpdir(), "aldev-home-"));
  tempDirs.push(home);
  if (config !== undefined) writeConfig(home, config);
  return home;
}

describe("coding-agent selection", () => {
  it("requires the config file before help", async () => {
    const stderr = makeSink();
    const home = makeHome();
    expect(await main({ argv: ["node", "aldev", "code", "--help"], env: {}, home, stderr })).toBe(
      1,
    );
    expect(stderr.text()).toContain("Error: no aldev config at ");
    expect(stderr.text()).toContain('"code.agent"');
  });

  it("rejects an invalid agent in the config", async () => {
    const stderr = makeSink();
    const home = makeHome({ platform: "codingAgent", code: { agent: "other" } });
    expect(await main({ argv: ["node", "aldev", "code", "--help"], env: {}, home, stderr })).toBe(
      1,
    );
    expect(stderr.text()).toContain("invalid aldev config");
    expect(stderr.text()).toContain("code.agent");
  });

  it("renders only the selected agent's models without discovery", async () => {
    const stdout = makeSink();
    const modelResolver = async () => {
      throw new Error("help must not discover models");
    };
    expect(
      await main({
        argv: ["node", "aldev", "code", "--help"],
        env: {},
        home: makeHome({ platform: "codingAgent", code: { agent: "codex" } }),
        stdout,
        modelResolver,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("aldev code new --protocol <protocol>");
    expect(stdout.text()).toContain("code.agent            Required coding agent");
    expect(stdout.text()).toContain("(selected: codex)");
    expect(stdout.text()).toContain("astra, sol, terra, luna");
    expect(stdout.text()).toContain("aldev guide code");
    expect(stdout.text()).not.toContain("Env:");
    expect(stdout.text()).not.toContain("reserve-side-ticket");
    expect(stdout.text()).not.toContain("fable");
  });

  it("renders the configured model list", async () => {
    const stdout = makeSink();
    const home = makeHome({
      platform: "codingAgent",
      code: { agent: "claude", models: ["sonnet", "haiku"] },
    });
    expect(await main({ argv: ["node", "aldev", "code", "--help"], env: {}, home, stdout })).toBe(
      0,
    );
    expect(stdout.text()).toContain("one of sonnet, haiku.");
  });
});

describe("parseCodeArgs", () => {
  it("maps the commands and flags", () => {
    expect(parseCodeArgs(["--help"], "aldev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["-h"], "aldev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["status", ".plans/1/_aldev/run.md"], "aldev")).toEqual({
      kind: "status",
      target: { kind: "file", sessionFile: ".plans/1/_aldev/run.md" },
    });
    expect(parseCodeArgs(["status", "--ticket", "AB-1"], "aldev")).toEqual({
      kind: "status",
      target: { kind: "ticket", ticket: "AB-1" },
    });
    expect(parseCodeArgs(["status", "--no-ticket"], "aldev")).toEqual({
      kind: "status",
      target: { kind: "noTicket" },
    });
    expect(parseCodeArgs(["quota"], "aldev")).toEqual({ kind: "quota" });
  });

  it("leaves the version and guide flags to other commands", () => {
    for (const flag of ["--version", "-v", "--guide", "--openclaw-guide"]) {
      expect(() => parseCodeArgs([flag], "aldev")).toThrow(`unknown command "${flag}"`);
    }
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
    expect(parseCodeArgs(["new", "--help"], "aldev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["resume", "-h"], "aldev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["status", "--help"], "aldev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["quota", "--help"], "aldev")).toEqual({ kind: "help" });
  });

  it("rejects a missing or unknown command", () => {
    expect(() => parseCodeArgs([], "aldev")).toThrow("no command given. Run `aldev code --help`.");
    expect(() => parseCodeArgs(["spec"], "aldev")).toThrow('unknown command "spec"');
    expect(() => parseCodeArgs(["--new"], "aldev")).toThrow('unknown command "--new"');
  });

  it("rejects unknown options, stray positionals, and a resume without an id", () => {
    expect(() => parse(["new", "--nope"])).toThrow();
    expect(() => parse(["new", "extra", "-m", "go"])).toThrow();
    const statusTargetError = "exactly one of <session-file>, --ticket <id>, --no-ticket";
    expect(() => parseCodeArgs(["status"], "aldev")).toThrow(statusTargetError);
    expect(() => parseCodeArgs(["status", "x.md", "--ticket", "1"], "aldev")).toThrow(
      statusTargetError,
    );
    expect(() => parseCodeArgs(["status", "--ticket", "1", "--no-ticket"], "aldev")).toThrow(
      statusTargetError,
    );
    expect(() => parseCodeArgs(["status", "--ticket", "../other"], "aldev")).toThrow(
      "--ticket must be a single path segment",
    );
    expect(() => parseCodeArgs(["status", "--meta", "k", "--no-ticket"], "aldev")).toThrow(
      statusTargetError,
    );
    expect(() => parse(["status", "--message", "go"])).toThrow();
    expect(() => parse(["quota", "extra"])).toThrow();
    expect(() => parse(["resume", "--message", "go"])).toThrow("exactly one <sessionId>");
    expect(() => parse(["resume", "a", "b", "--message", "go"])).toThrow("exactly one <sessionId>");
  });
});

describe("validateSessionArgs", () => {
  it("rejects an unknown protocol", () => {
    expect(validate(["new", "--protocol", "bogus", "--ticket", "1"])).toBe(
      "Error: --protocol must be one of: spec, plan, aad, description, review, merge.",
    );
  });

  it("rejects a model outside the allowlist", () => {
    expect(validate(["new", "--message", "go", "--model", "claude-opus-5-5"])).toBe(
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
    dir = mkdtempSync(join(tmpdir(), "aldev-status-"));
    writeConfig(dir, { platform: "codingAgent", code: { agent: "claude" } });
    sessionFilePath = join(dir, ".plans", "1", "_aldev", "run.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeStatusRecord(
    pid: number,
    path: string = sessionFilePath,
    ticket: string | null = "1",
  ): void {
    writeInitialSessionFile(path, {
      status: "running",
      agent: "claude",
      protocol: "review",
      ticket,
      model: null,
      sessionId: "sess-42",
      command: "aldev code new --protocol review --ticket 1",
      meta: null,
      pid,
      pidStartTime: null,
      cwd: dir,
      startedAt: "2026-08-29T11:55:29.000Z",
      endedAt: null,
      exitReason: null,
      contextTokens: 162_400,
      contextCompacted: false,
      contextTokensError: null,
    });
  }

  it("reconciles and reports a dead run without a coding agent", async () => {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    writeStatusRecord(child.pid);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aldev", "code", "status", ".plans/1/_aldev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain(
      "sessionFile: .plans/1/_aldev/run.md\nsessionId: sess-42\nstatus: failed\n",
    );
    expect(stdout.text()).toContain("exitReason: terminated\n");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("reports a live run without changing its record", async () => {
    writeStatusRecord(process.pid);
    const stdout = makeSink();
    expect(
      await main({
        argv: ["node", "aldev", "code", "status", ".plans/1/_aldev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("status: running\n");
    expect(stdout.text()).toContain("contextTokens: 162400\n");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("running");
  });

  it("selects the newest same-stamp ticket run by numeric suffix", async () => {
    const firstPath = join(dir, ".plans", "1", "_aldev", "20260829-115529.md");
    const secondPath = join(dir, ".plans", "1", "_aldev", "20260829-115529-2.md");
    writeStatusRecord(process.pid, firstPath);
    writeStatusRecord(process.pid, secondPath);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aldev", "code", "status", "--ticket", "1"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("sessionFile: .plans/1/_aldev/20260829-115529-2.md\n");
  });

  it("selects the newest no-ticket run", async () => {
    const noTicketPath = join(dir, ".plans", "_aldev", "20260829-115529.md");
    writeStatusRecord(process.pid, noTicketPath, null);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aldev", "code", "status", "--no-ticket"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("sessionFile: .plans/_aldev/20260829-115529.md\n");
  });

  it("reports an empty scoped session directory", async () => {
    mkdirSync(join(dir, ".plans", "1", "_aldev"), { recursive: true });
    const stderr = makeSink();

    expect(
      await main({
        argv: ["node", "aldev", "code", "status", "--ticket", "1"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("Error: no session file under .plans/1/_aldev/.\n");
  });

  it("rejects files outside the session-record tree", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aldev", "code", "status", "notes.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      "Error: status requires a session file under .plans/_aldev/ or .plans/<ticket>/_aldev/.\n",
    );
  });

  it("reports a missing session file in its own words", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aldev", "code", "status", ".plans/1/_aldev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("Error: session file not found: .plans/1/_aldev/run.md\n");
  });

  it("rejects a session-path symlink that resolves outside .plans", async () => {
    mkdirSync(join(dir, ".plans", "1", "_aldev"), { recursive: true });
    const outsidePath = join(dir, "outside.md");
    writeFileSync(outsidePath, "keep me");
    symlinkSync(outsidePath, sessionFilePath);
    const stderr = makeSink();

    expect(
      await main({
        argv: ["node", "aldev", "code", "status", ".plans/1/_aldev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("resolves outside");
  });
});

describe("quota", () => {
  it("reads the quota without a plans directory or model discovery", async () => {
    const stdout = makeSink();
    const modelResolver = vi.fn(async () => {
      throw new Error("quota must not discover models");
    });
    const quotaReader = vi.fn(async () => "Claude Code quota\n\nCurrent session: 25% used");

    expect(
      await main({
        argv: ["node", "aldev", "code", "quota"],
        cwd: tmpdir(),
        env: { KEEP: "yes" },
        home: makeHome({ platform: "codingAgent", code: { agent: "claude", unset: ["SECRET"] } }),
        stdout,
        modelResolver,
        quotaReader,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe("Claude Code quota\n\nCurrent session: 25% used\n");
    expect(quotaReader).toHaveBeenCalledWith("claude", {
      cwd: tmpdir(),
      env: { KEEP: "yes" },
      unset: ["SECRET"],
    });
    expect(modelResolver).not.toHaveBeenCalled();
  });

  it("reports quota failures", async () => {
    const stderr = makeSink();
    const quotaReader = async () => {
      throw new Error("limits unavailable");
    };
    expect(
      await main({
        argv: ["node", "aldev", "code", "quota"],
        env: {},
        home: makeHome({ platform: "codingAgent", code: { agent: "codex" } }),
        stderr,
        quotaReader,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("limits unavailable\n");
  });
});

describe("resolveTicket", () => {
  function record(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return {
      path: "/proj/.plans/30/_aldev/r.md",
      frontmatter: {
        status: "succeeded",
        agent: "claude",
        protocol: "spec",
        ticket: "30",
        model: null,
        sessionId: "abc",
        command: "aldev code new --protocol spec --ticket 30 --message go",
        meta: null,
        pid: null,
        pidStartTime: null,
        cwd: "/proj",
        startedAt: "2026-07-01T09:15:03.000Z",
        endedAt: null,
        exitReason: null,
        contextTokens: null,
        contextCompacted: false,
        contextTokensError: null,
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

  it("ignores _-prefixed segments such as _aldev", () => {
    const parsed = parse(["new", "--message", "See .plans/_aldev/20260706-122913.md"]);
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
  const CODE: CodeConfig = { agent: "claude", skipPermissions: false, unset: [] };

  function build(overrides: Partial<RunInput>): RunConfig {
    return buildRunConfig({
      args: parse(["new", "--message", "go"]),
      code: CODE,
      report: reportWithCompanion([]),
      ticket: undefined,
      cwd: "/proj",
      sessionFilePath: "/proj/.plans/_aldev/s.md",
      env: {},
      executableModel: undefined,
      alignfirst: "alignfirst",
      ...overrides,
    });
  }

  it("threads the caller env into the config so the child inherits the same source", () => {
    const env = { FOO: "bar" };
    const config = build({
      code: { agent: "claude", skipPermissions: true, unset: ["X", "Y"] },
      env,
    });
    expect(config.env).toBe(env);
    expect(config.executableModel).toBeUndefined();
    expect(config.skipPermissions).toBe(true);
    expect(config.unset).toEqual(["X", "Y"]);
    expect(config.resume).toBeUndefined();
  });

  it("puts the effective ticket, not the flag, in the prompt", () => {
    const config = build({ args: parse(["resume", "abc", "--protocol", "plan"]), ticket: "30" });
    expect(config.prompt).toBe(
      "Run `alignfirst guide plan` and follow the protocol. Ticket ID = 30.",
    );
    expect(config.resume).toBe("abc");
    expect(config.skipPermissions).toBe(false);
  });

  it("adds the companion as a writable directory when it holds project files", () => {
    const items: ItemName[] = [
      ".alignfirst.json",
      ".alignfirst.md",
      "DEVELOPERS.md",
      "docs",
      ".plans",
    ];
    for (const item of items) {
      const report = reportWithCompanion([item]);
      expect(build({ report }).additionalDirectories).toEqual(["/companions/proj"]);
    }
  });

  it("adds no directory without companion files, or with skipPermissions", () => {
    expect(build({ report: reportWithCompanion([]) }).additionalDirectories).toEqual([]);
    expect(build({ report: reportWithCompanion(["_aldev"]) }).additionalDirectories).toEqual([]);
    const skipped = build({
      code: { ...CODE, skipPermissions: true },
      report: reportWithCompanion([".plans"]),
    });
    expect(skipped.additionalDirectories).toEqual([]);
  });
});

// A report whose companion `/companions/proj` holds the given items.
function reportWithCompanion(items: ItemName[]): ProjectReport {
  const location = (name: string, item: ItemName): ItemLocation =>
    items.includes(item)
      ? { path: `/companions/proj/${name}`, in: "companion", exists: true }
      : { path: `/proj/${name}`, in: "project", exists: true };
  return {
    source: "project",
    cli: null,
    config: null,
    companion: { dir: "/companions/proj", exists: true },
    locations: {
      ".alignfirst.json": location(".alignfirst.json", ".alignfirst.json"),
      ".alignfirst.md": location(".alignfirst.md", ".alignfirst.md"),
      "DEVELOPERS.md": location("DEVELOPERS.md", "DEVELOPERS.md"),
      docs: location("docs", "docs"),
      ".plans": location(".plans", ".plans"),
      _aldev: location(".plans", "_aldev"),
    },
  };
}

describe("launch guards", () => {
  let dir: string;
  let plans: string;
  let home: string;
  let realCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aldev-guards-"));
    plans = join(dir, ".plans");
    mkdirSync(plans);
    realCwd = realpathSync(dir);
    home = join(dir, "home");
    writeConfig(home, { platform: "codingAgent", code: { agent: "claude" } });
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
      command: "aldev code new --protocol spec --ticket 30 --message go",
      meta: null,
      pid: process.pid,
      pidStartTime: null,
      cwd: realCwd,
      startedAt: "2026-07-01T09:15:03.000Z",
      endedAt: null,
      exitReason: null,
      contextTokens: null,
      contextCompacted: false,
      contextTokensError: null,
      ...overrides,
    };
  }

  function seedRecord(name: string, overrides: Partial<SessionFrontmatter>): void {
    writeInitialSessionFile(join(dir, ".plans", "30", "_aldev", name), makeFrontmatter(overrides));
  }

  async function run(tokens: string[]): Promise<{ code: number; stderr: string }> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aldev", "code", ...tokens],
      stdout,
      stderr,
      cwd: dir,
      env: { HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
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
    const before = listSessionRecords(plans, plans).length;
    const modelResolver = vi.fn(async () => "gpt-5.6-terra");
    const stderr = makeSink();
    const otherHome = makeHome({
      platform: "codingAgent",
      code: { agent: "claude", models: ["terra"] },
    });
    const code = await main({
      argv: ["node", "aldev", "code", "resume", "abc", "--message", "go", "--model", "terra"],
      cwd: dir,
      env: { HOME: otherHome },
      home: otherHome,
      alignfirstCommand: ALIGNFIRST,
      stderr,
      modelResolver,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("belongs to agent codex");
    expect(modelResolver).not.toHaveBeenCalled();
    expect(listSessionRecords(plans, plans)).toHaveLength(before);
  });

  it("seals model-discovery failures in the session file", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const codexHome = makeHome({ platform: "codingAgent", code: { agent: "codex" } });
    const code = await main({
      argv: ["node", "aldev", "code", "new", "--message", "go", "--model", "terra"],
      cwd: dir,
      env: { HOME: codexHome },
      home: codexHome,
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
      modelResolver: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toContain("Session file:");
    expect(stderr.text()).toContain("catalog unavailable");
    const records = listSessionRecords(plans, plans);
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
      argv: ["node", "aldev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      cwd: dir,
      env: { HOME: home },
      home,
      stdout,
      stderr: makeSink(),
      alignfirstCommand: ALIGNFIRST,
      modelResolver: async () => {
        throw new Error("stop before spawning");
      },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toContain(`Session file: ${join(".plans", "side-2", "_aldev")}`);
    const [record] = listSessionRecords(plans, plans);
    expect(record.frontmatter.ticket).toBe("side-2");
    expect(record.frontmatter.command).toBe(
      'aldev code new --protocol aad --no-ticket --message "go"',
    );
  });

  it("reports a missing alignfirst executable before writing a session file", async () => {
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aldev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      cwd: dir,
      env: { HOME: home },
      home,
      stderr,
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain("alignfirst is not installed");
    expect(listSessionRecords(plans, plans)).toEqual([]);
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
        path: "/elsewhere/.plans/30/_aldev/r.md",
        frontmatter: makeFrontmatter({ sessionId: "abc", cwd: "/elsewhere" }),
      },
    ];
    expect(checkLaunchGuards(parsed, "claude", realCwd, records)).toBeUndefined();
  });

  it("exempts no-protocol invocations from the busy-worktree guard", () => {
    const records = [
      {
        path: join(dir, ".plans", "30", "_aldev", "r.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc" }),
      },
      // A resumable (finished) record so only the busy-worktree guard is in play.
      {
        path: join(dir, ".plans", "30", "_aldev", "done.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc2", status: "succeeded" }),
      },
    ];
    const answer = parse(["resume", "abc2", "--message", "answer"]);
    expect(checkLaunchGuards(answer, "claude", realCwd, records)).toBeUndefined();

    const execute = parse(["new", "--message", "Execute the plan"]);
    expect(checkLaunchGuards(execute, "claude", realCwd, records)).toBeUndefined();
  });
});

describe("companion projects", () => {
  let base: string;
  let home: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aldev-companion-"));
    home = join(base, "home");
    writeConfig(home, { platform: "codingAgent", code: { agent: "claude" } });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  interface RunOutcome {
    code: number;
    stdout: string;
    stderr: string;
  }

  async function run(
    project: CompanionProject,
    tokens: string[],
    path: string = process.env.PATH ?? "",
  ): Promise<RunOutcome> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aldev", "code", ...tokens],
      cwd: project.project,
      env: { PATH: path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
      modelResolver: async () => {
        throw new Error("stop before spawning");
      },
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("gates on the companion .plans and writes the session file there", async () => {
    const project = makeCompanionProject(home, { ".plans": true });
    const plans = join(project.companion, ".plans");

    const gated = await run(project, ["new", "-m", "go"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toBe(
      `Error: no .plans/ directory at ${plans}. ` +
        "Create it, or run `alignfirst plans setup <clone>`.\n",
    );

    mkdirSync(plans, { recursive: true });
    const started = await run(project, ["new", "-m", "go"]);
    expect(started.stderr).toContain("stop before spawning");
    expect(started.stdout).toContain(`Session file: ${join(plans, "_aldev")}/`);
    expect(listSessionRecords(plans, plans)).toHaveLength(1);
  });

  it("writes a separate _aldev tree and keeps only the active tickets of .plans", async () => {
    const project = makeCompanionProject(home, { ".plans": false, _aldev: true });
    const plans = join(project.project, ".plans");
    const sessions = join(project.companion, ".plans");
    mkdirSync(join(plans, "29"), { recursive: true });

    const started = await run(project, ["new", "--ticket", "29", "-m", "go"]);
    expect(started.stdout).toContain(`Session file: ${join(sessions, "29", "_aldev")}/`);
    expect(listSessionRecords(sessions, plans)).toHaveLength(1);

    rmSync(join(plans, "29"), { recursive: true });
    expect(listSessionRecords(sessions, plans)).toEqual([]);
  });

  it("reserves a side ticket in the companion .plans", async () => {
    const project = makeCompanionProject(home, { ".plans": true });
    const plans = join(project.companion, ".plans");
    mkdirSync(join(plans, "side-1"), { recursive: true });

    const started = await run(project, ["new", "--protocol", "aad", "--no-ticket", "-m", "go"]);
    expect(started.stdout).toContain(`Session file: ${join(plans, "side-2", "_aldev")}/`);
  });

  describe("status", () => {
    let project: CompanionProject;
    let ticketFile: string;
    let noTicketFile: string;
    beforeEach(() => {
      project = makeCompanionProject(home, { ".plans": false, _aldev: true });
      mkdirSync(join(project.project, ".plans", "29"), { recursive: true });
      const sessions = join(project.companion, ".plans");
      ticketFile = join(sessions, "29", "_aldev", "20260829-115529.md");
      noTicketFile = join(sessions, "_aldev", "20260829-115530.md");
      writeInitialSessionFile(ticketFile, statusFrontmatter({ ticket: "29", meta: "thread-1" }));
      writeInitialSessionFile(noTicketFile, statusFrontmatter({ ticket: null }));
    });

    it("finds a run by path, ticket, no-ticket and meta, and prints absolute paths", async () => {
      const cases: [string[], string][] = [
        [["status", ticketFile], ticketFile],
        [["status", relative(project.project, ticketFile)], ticketFile],
        [["status", "--ticket", "29"], ticketFile],
        [["status", "--no-ticket"], noTicketFile],
        [["status", "--meta", "thread-1"], ticketFile],
      ];
      for (const [tokens, expected] of cases) {
        const result = await run(project, tokens);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`sessionFile: ${expected}\n`);
      }
    });

    it("rejects a session file outside the sessions directory", async () => {
      const projectFile = join(project.project, ".plans", "29", "_aldev", "20260829-115529.md");
      writeInitialSessionFile(projectFile, statusFrontmatter({ ticket: "29" }));
      const sessions = join(project.companion, ".plans");

      const result = await run(project, ["status", ".plans/29/_aldev/20260829-115529.md"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `Error: status requires a session file under ${sessions}/_aldev/ or ` +
          `${sessions}/<ticket>/_aldev/.\n`,
      );
    });
  });

  it("adds the companion directory and the project context for the coder", async () => {
    const project = makeCompanionProject(home, { ".plans": true });
    mkdirSync(join(project.companion, ".plans"), { recursive: true });
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  writeFileSync(join(${JSON.stringify(bin)}, "prompt.txt"), prompt);
  writeFileSync(join(${JSON.stringify(bin)}, "args.json"), JSON.stringify(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "session-1" }));
});
`,
      { mode: 0o755 },
    );
    const path = `${bin}:${process.env.PATH ?? ""}`;
    const received = () => ({
      prompt: readFileSync(join(bin, "prompt.txt"), "utf8"),
      args: JSON.parse(readFileSync(join(bin, "args.json"), "utf8")),
    });

    const stdout = makeSink();
    const started = await main({
      argv: ["node", "aldev", "code", "new", "-m", "go"],
      cwd: project.project,
      env: { PATH: path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr: makeSink(),
      modelResolver: async () => undefined,
    });
    expect(started).toBe(0);
    const first = received();
    expect(first.prompt).toMatch(/^## Project context\n\n# Project Conventions\n/);
    expect(first.prompt).toMatch(/\n\n## Current instruction\n\ngo$/);
    expect(first.args).toEqual(expect.arrayContaining(["--add-dir", project.companion]));

    const resumed = await main({
      argv: ["node", "aldev", "code", "resume", "session-1", "-m", "more"],
      cwd: project.project,
      env: { PATH: path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout: makeSink(),
      stderr: makeSink(),
      modelResolver: async () => undefined,
    });
    expect(resumed).toBe(0);
    const second = received();
    expect(second.prompt).toBe("more");
    expect(second.args).toEqual(expect.arrayContaining(["--add-dir", project.companion]));
  });
});

function statusFrontmatter(overrides: Partial<SessionFrontmatter>): SessionFrontmatter {
  return {
    status: "succeeded",
    agent: "claude",
    protocol: "review",
    ticket: null,
    model: null,
    sessionId: "sess-42",
    command: "aldev code new --protocol review",
    meta: null,
    pid: null,
    pidStartTime: null,
    cwd: null,
    startedAt: "2026-08-29T11:55:29.000Z",
    endedAt: "2026-08-29T11:56:29.000Z",
    exitReason: "completed",
    contextTokens: null,
    contextCompacted: false,
    contextTokensError: null,
    ...overrides,
  };
}
