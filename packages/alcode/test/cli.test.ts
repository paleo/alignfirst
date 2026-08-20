import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AlcodeArgs,
  buildRunConfig,
  checkLaunchGuards,
  main,
  parseAlcodeArgs,
  resolveTicket,
  validateArgs,
} from "../src/cli.js";
import { DEFAULT_MODELS } from "../src/models.js";
import {
  type SessionFrontmatter,
  type SessionRecord,
  listSessionRecords,
  writeInitialSessionFile,
} from "../src/session-file.js";

function parse(flags: string[]): AlcodeArgs {
  return parseAlcodeArgs(["node", "alcode", ...flags]);
}

function validate(flags: string[], models: readonly string[] = DEFAULT_MODELS): string | undefined {
  return validateArgs(parse(flags), models);
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
    expect(stdout.text()).not.toContain("fable");
  });
});

describe("parseAlcodeArgs", () => {
  it("reads the flags into camelCase fields", () => {
    const args = parse(["--new", "--protocol", "aad", "--ticket", "29", "--message", "go"]);
    expect(args.isNew).toBe(true);
    expect(args.protocol).toBe("aad");
    expect(args.ticket).toBe("29");
    expect(args.message).toBe("go");
  });

  it("reads --meta as an opaque string", () => {
    const args = parse(["--new", "--message", "go", "--meta", "thread:room/abc.def"]);
    expect(args.meta).toBe("thread:room/abc.def");
  });

  it("leaves meta undefined when --meta is omitted", () => {
    expect(parse(["--new", "--message", "go"]).meta).toBeUndefined();
  });

  it("throws on unknown flags", () => {
    expect(() => parse(["--nope"])).toThrow();
  });
});

describe("validateArgs — parity with the retired .mjs", () => {
  it("rejects --new with --resume", () => {
    expect(validate(["--new", "--resume", "s"])).toBe(
      "Error: --new and --resume are mutually exclusive.",
    );
  });

  it("requires one of --new or --resume", () => {
    expect(validate(["--message", "hi"])).toBe(
      "Error: at least one of --new or --resume is required.",
    );
  });

  it("rejects an unknown protocol", () => {
    expect(validate(["--new", "--protocol", "bogus", "--ticket", "1"])).toBe(
      "Error: --protocol must be one of: spec, plan, aad, description, read, review, merge.",
    );
  });

  it("rejects a model outside the allowlist", () => {
    expect(validate(["--new", "--message", "go", "--model", "claude-opus-5"])).toBe(
      "Error: --model must be one of: fable, opus, sonnet, haiku.",
    );
  });

  it("accepts an allowlisted model, on --new and on --resume", () => {
    expect(validate(["--new", "--message", "go", "--model", "opus"])).toBe(undefined);
    expect(validate(["--resume", "s", "--message", "m", "--model", "haiku"])).toBe(undefined);
  });

  it("validates against the host's model list when one is configured", () => {
    const models = ["sonnet", "haiku"];
    expect(validate(["--new", "--message", "go", "--model", "sonnet"], models)).toBe(undefined);
    expect(validate(["--new", "--message", "go", "--model", "opus"], models)).toBe(
      "Error: --model must be one of: sonnet, haiku.",
    );
  });

  it("requires --message when no protocol", () => {
    expect(validate(["--new"])).toBe(
      "Error: --message is required when --protocol is not specified.",
    );
  });

  it("requires --ticket with --new + --protocol", () => {
    expect(validate(["--new", "--protocol", "plan"])).toBe(
      "Error: --ticket is required with --new and --protocol.",
    );
  });

  it("requires --message for spec and aad", () => {
    expect(validate(["--new", "--protocol", "spec", "--ticket", "1"])).toBe(
      "Error: --protocol spec requires --message.",
    );
    expect(validate(["--new", "--protocol", "aad", "--ticket", "1"])).toBe(
      "Error: --protocol aad requires --message.",
    );
  });

  it("accepts --ticket with --resume as an explicit override", () => {
    expect(validate(["--resume", "s", "--ticket", "1", "--message", "m"])).toBe(undefined);
  });

  it("accepts a valid spec run", () => {
    expect(validate(["--new", "--protocol", "spec", "--ticket", "1", "--message", "m"])).toBe(
      undefined,
    );
  });

  it("accepts a resume with no protocol and a message", () => {
    expect(validate(["--resume", "s", "--message", "answer"])).toBe(undefined);
  });

  it("accepts a non-numeric ticket format (consumer repos vary)", () => {
    expect(validate(["--new", "--protocol", "plan", "--ticket", "AB-123_x.4"])).toBe(undefined);
  });

  it("rejects a ticket with a path separator or traversal", () => {
    const expected =
      "Error: --ticket must be a single path segment " +
      "(letters, digits, '.', '-', '_'); no path separators or '..'.";
    expect(validate(["--new", "--protocol", "plan", "--ticket", "../../etc"])).toBe(expected);
    expect(validate(["--new", "--protocol", "plan", "--ticket", "a/b"])).toBe(expected);
    expect(validate(["--new", "--protocol", "plan", "--ticket", ".."])).toBe(expected);
    expect(validate(["--resume", "s", "--ticket", "a/b", "--message", "m"])).toBe(expected);
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
        command: "alcode --new --protocol spec --ticket 30 --message go",
        meta: null,
        pid: null,
        cwd: "/proj",
        startedAt: "2026-07-01T09:15:03.000Z",
        endedAt: null,
        exitReason: null,
        ...overrides,
      },
    };
  }

  it("prefers the explicit --ticket over resume inheritance and message inference", () => {
    const withResume = parse(["--resume", "abc", "--ticket", "9", "--message", "m"]);
    expect(resolveTicket(withResume, [record({})])).toBe("9");

    const withMessage = parse(["--new", "--ticket", "9", "--message", "See .plans/2/B2-plan.md"]);
    expect(resolveTicket(withMessage, [])).toBe("9");
  });

  it("resume inherits the latest non-null ticket among the session's records", () => {
    const records = [
      record({ ticket: "30", startedAt: "2026-07-01T09:00:00.000Z" }),
      record({ ticket: "31", startedAt: "2026-07-01T10:00:00.000Z" }),
      record({ ticket: null, startedAt: "2026-07-01T11:00:00.000Z" }),
      record({ ticket: "99", sessionId: "other", startedAt: "2026-07-01T12:00:00.000Z" }),
    ];
    expect(resolveTicket(parse(["--resume", "abc", "--message", "m"]), records)).toBe("31");
  });

  it("resume without any ticketed record yields no ticket", () => {
    const records = [record({ ticket: null })];
    expect(resolveTicket(parse(["--resume", "abc", "--message", "m"]), records)).toBeUndefined();
  });

  it("infers the ticket from a .plans/<ticket>/ path in the message", () => {
    const parsed = parse(["--new", "--message", "Execute the plan: .plans/2/B2-plan.md"]);
    expect(resolveTicket(parsed, [])).toBe("2");
  });

  it("ignores _-prefixed segments such as _alcode", () => {
    const parsed = parse(["--new", "--message", "See .plans/_alcode/20260706-122913.md"]);
    expect(resolveTicket(parsed, [])).toBeUndefined();
  });

  it("falls back to no ticket on conflicting inferred segments", () => {
    const parsed = parse(["--new", "--message", "Compare .plans/2/a.md with .plans/3/b.md"]);
    expect(resolveTicket(parsed, [])).toBeUndefined();

    const repeated = parse(["--new", "--message", "Read .plans/2/a.md then .plans/2/b.md"]);
    expect(resolveTicket(repeated, [])).toBe("2");
  });

  it("yields no ticket for a --new run without a message", () => {
    expect(resolveTicket(parse(["--new"]), [])).toBeUndefined();
  });
});

describe("buildRunConfig", () => {
  it("threads the caller env into the config so the child inherits the same source", () => {
    const parsed = parse(["--new", "--message", "go"]);
    const env = { FOO: "bar", ALIGNFIRST_CODE_SKIP_PERMISSIONS: "1", ALIGNFIRST_CODE_UNSET: "X,Y" };
    const config = buildRunConfig(parsed, "/proj", "/proj/.plans/_alcode/s.md", env);
    expect(config.env).toBe(env);
    expect(config.skipPermissions).toBe(true);
    expect(config.unset).toEqual(["X", "Y"]);
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
      command: "alcode --new --protocol spec --ticket 30 --message go",
      meta: null,
      pid: process.pid,
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

  async function run(flags: string[]): Promise<{ code: number; stderr: string }> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "alcode", ...flags],
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
    const { code, stderr } = await run(["--resume", "zzz", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown session id zzz");
    expect(stderr.indexOf("bbb")).toBeLessThan(stderr.indexOf("aaa")); // most recent first
    expect(stderr).toContain("ticket 30");
  });

  it("says plainly when no session records exist at all", async () => {
    const { code, stderr } = await run(["--resume", "zzz", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no session records exist");
  });

  it("rejects resuming a session that is still running", async () => {
    seedRecord("running.md", { sessionId: "abc" });
    const { code, stderr } = await run(["--resume", "abc", "--message", "hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`session abc is still running (pid ${process.pid})`);
  });

  it("rejects legacy and cross-agent resumes", () => {
    const parsed = parse(["--resume", "abc", "--message", "continue"]);
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
      argv: ["node", "alcode", "--resume", "abc", "--message", "go", "--model", "terra"],
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

  it("rejects a protocol run while another run is active in the same worktree", async () => {
    seedRecord("running.md", { sessionId: "abc" });
    const { code, stderr } = await run(["--new", "--protocol", "plan", "--ticket", "31"]);
    expect(code).toBe(1);
    expect(stderr).toContain("a protocol run is already active in this worktree");
    expect(stderr).toContain(`pid ${process.pid}`);
  });

  it("allows a protocol run when the active run sits in another worktree", () => {
    const parsed = parse(["--new", "--protocol", "plan", "--ticket", "31"]);
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
    const answer = parse(["--resume", "abc2", "--message", "answer"]);
    expect(checkLaunchGuards(answer, "claude", realCwd, records)).toBeUndefined();

    const execute = parse(["--new", "--message", "Execute the plan"]);
    expect(checkLaunchGuards(execute, "claude", realCwd, records)).toBeUndefined();
  });
});
