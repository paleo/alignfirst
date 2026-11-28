import {
  existsSync,
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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main as runMain, type MainOptions } from "../../src/cli.js";
import {
  buildRunConfig,
  checkLaunchGuards,
  parseCodeArgs,
  type RunInput,
  resolveTicket,
  type SessionArgs,
  validateSessionArgs,
} from "../../src/code/code-cli.js";
import type { CodingAgent } from "../../src/code/coding-agent.js";
import { resolveEfforts } from "../../src/code/efforts.js";
import { readMachineId } from "../../src/code/machine-id.js";
import { CLAUDE_DEFAULT_MODELS, resolveModels } from "../../src/code/models.js";
import {
  appendTranscript,
  applyCompletion,
  RESULT_MARKER,
  type SessionFrontmatter,
  type SessionRecord,
  listSessionRecords,
  readCompletion,
  writeInitialSessionFile,
} from "../../src/code/session-file.js";
import type { CodeConfig } from "../../src/config.js";
import type { RunConfig } from "../../src/code/run-agent.js";
import type { ItemLocation, ItemName, ProjectReport } from "../../src/project/layout.js";
import { makeSink, writeConfig } from "../helpers.js";
import {
  addInitialCommit,
  addWorktree,
  makeFixture,
  makeRepository,
  useProjectFixtures,
} from "../project/fixtures.js";
import {
  type AlignfirstStub,
  type FakeAgent,
  installFakeAgent,
  printJsonLines,
  quote,
  type StubOptions,
  writeAlignfirstStub,
} from "../stand-ins.js";

// The default `claude` reply: a result for the resumed session, else for `session-1`.
const CLAUDE_RESULT = `id=session-1
previous=
for arg in "$@"; do
  if [ "$previous" = --resume ]; then id=$arg; fi
  previous=$arg
done
printf '{"type":"result","result":"done","session_id":"%s"}' "$id"`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs aligndev in `cwd` (default: home) against a stub alignfirst written for that directory.
function main(options: MainOptions & { home: string; stub?: AlignfirstStub }): Promise<number> {
  const cwd = options.cwd ?? options.home;
  return runMain({
    ...options,
    cwd,
    env: { HOME: options.home, ...options.env },
    alignfirstCommand: (options.stub ?? writeAlignfirstStub(makeTempDir(), cwd)).command,
  });
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aligndev-code-"));
  tempDirs.push(dir);
  return dir;
}

function parse(tokens: string[]): SessionArgs {
  const command = parseCodeArgs(tokens, "aligndev");
  if (command.kind !== "session")
    throw new Error(`expected a session command, got ${command.kind}`);
  return command.args;
}

function makeHome(config?: object): string {
  const home = makeTempDir();
  if (config !== undefined) writeConfig(home, config);
  return home;
}

function installFakeClaude(base: string, body = CLAUDE_RESULT): FakeAgent {
  return installFakeAgent(base, "claude", body);
}

describe("coding-agent selection", () => {
  it("requires a configured or detected agent before help", async () => {
    const home = makeHome();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "--help"],
        env: {},
        home,
        stderr: makeSink(),
      }),
    ).toBe(1);
  });

  it("allows help without model discovery", async () => {
    const modelResolver = async () => {
      throw new Error("help must not discover models");
    };
    expect(
      await main({
        argv: ["node", "aligndev", "code", "--help"],
        env: {},
        home: makeHome({ code: { harness: "codex" } }),
        stdout: makeSink(),
        modelResolver,
      }),
    ).toBe(0);
  });
});

describe("parseCodeArgs", () => {
  it.each<[string[], object]>([
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["quota"], { kind: "quota" }],
    [
      ["status", ".plans/1/_aligndev/run.md"],
      {
        kind: "status",
        target: { kind: "file", sessionFile: ".plans/1/_aligndev/run.md" },
        includeResult: false,
      },
    ],
    [
      ["status", "--result", "--ticket", "AB-1"],
      { kind: "status", target: { kind: "ticket", ticket: "AB-1" }, includeResult: true },
    ],
    [["status", "--no-ticket"], { kind: "status", target: { kind: "noTicket" } }],
    [["status", "--meta", "k"], { kind: "status", target: { kind: "meta", meta: "k" } }],
    [
      ["new", "--protocol", "aad", "--ticket", "29", "--message", "go"],
      {
        kind: "session",
        args: { protocol: "aad", ticket: "29", noTicket: false, message: "go" },
      },
    ],
    [
      ["resume", "abc", "--protocol", "plan", "--quiet"],
      { kind: "session", args: { resume: "abc", protocol: "plan", quiet: true } },
    ],
    [
      ["new", "--no-ticket", "--protocol", "aad", "-m", "go", "--meta", "thread:room/abc.def"],
      { kind: "session", args: { noTicket: true, meta: "thread:room/abc.def" } },
    ],
  ])("maps %j", (tokens, expected) => {
    expect(parseCodeArgs(tokens, "aligndev")).toMatchObject(expected);
  });

  it.each([
    [[]],
    [["spec"]],
    [["--new"]],
    [["new", "--nope"]],
    [["new", "extra", "-m", "go"]],
    [["new", "-m", "go", "--result"]],
    [["resume", "--message", "go"]],
    [["resume", "a", "b", "--message", "go"]],
    [["resume", "abc", "--no-ticket"]],
    [["status"]],
    [["status", "--result"]],
    [["status", "a.md", "b.md"]],
    [["status", "x.md", "--ticket", "1"]],
    [["status", "--ticket", "1", "--no-ticket"]],
    [["status", "--no-ticket", "--meta", "k"]],
    [["status", "--ticket", "../other"]],
    [["status", "run.md", "--quiet"]],
    [["status", "--message", "go"]],
    [["quota", "extra"]],
  ])("rejects %j", (tokens) => {
    expect(() => parseCodeArgs(tokens, "aligndev")).toThrow(Error);
  });
});

describe("validateSessionArgs", () => {
  const CUSTOM = ["sonnet", "haiku"];

  function validate(
    tokens: string[],
    agent: CodingAgent = "claude",
    models: readonly string[] | undefined = agent === "claude"
      ? CLAUDE_DEFAULT_MODELS
      : resolveModels(agent, undefined, undefined),
  ): string | undefined {
    return validateSessionArgs(parse(tokens), models, resolveEfforts(agent, undefined));
  }

  it.each<[string[], CodingAgent?, string[]?]>([
    [["new", "--protocol", "bogus", "--ticket", "1", "-m", "go"]],
    [["new", "--protocol", "catchup", "--ticket", "29"]],
    [["new", "-m", "go", "--model", "not-listed"]],
    [["new", "-m", "go", "--model", "opus"], "claude", CUSTOM],
    [["new", "-m", "go", "--model", ""], "pi"],
    [["new", "-m", "go", "--model", " \t "], "pi"],
    [["new", "-m", "go", "--model", "terra"], "pi", ["provider/model"]],
    [["new", "-m", "go", "--effort", "minimal"]],
    [["resume", "s", "-m", "m", "--effort", "minimal"]],
    [["new"]],
    [["resume", "s"]],
    [["new", "--message", "   "]],
    [["resume", "s", "--catchup"]],
    [["new", "--protocol", "plan"]],
    [["new", "--protocol", "plan", "--ticket", "1", "--no-ticket"]],
    [["new", "--no-ticket", "-m", "go"]],
    [["new", "--protocol", "spec", "--ticket", "1"]],
    [["new", "--protocol", "aad", "--no-ticket", "--message", "\t"]],
    [["new", "--protocol", "plan", "--ticket", "../../etc"]],
    [["new", "--protocol", "plan", "--ticket", "a/b"]],
    [["new", "--protocol", "plan", "--ticket", ".."]],
    [["resume", "s", "--ticket", "a/b", "-m", "m"]],
  ])("rejects %j (%s)", (tokens, agent, models) => {
    expect(validate(tokens, agent, models)).toBeDefined();
  });

  it.each<[string[], CodingAgent?, string[]?]>([
    [["new", "-m", "go", "--model", "opus"]],
    [["resume", "s", "-m", "m", "--model", "haiku"]],
    [["new", "-m", "go", "--model", "sonnet"], "claude", CUSTOM],
    [["new", "-m", "go", "--model", " provider/model:high "], "pi"],
    [["new", "-m", "go", "--effort", "high"]],
    [["new", "--catchup", "--ticket", "29"]],
    [["new", "--protocol", "plan", "--ticket", "AB-123_x.4"]],
    [["new", "--protocol", "plan", "--no-ticket"]],
    [["resume", "s", "--protocol", "plan"]],
    [["resume", "s", "--ticket", "1", "-m", "m"]],
  ])("accepts %j (%s)", (tokens, agent, models) => {
    expect(validate(tokens, agent, models)).toBeUndefined();
  });
});

describe("status", () => {
  let dir: string;
  let sessionFilePath: string;
  beforeEach(() => {
    dir = makeTempDir();
    writeConfig(dir, { code: { harness: "claude" } });
    sessionFilePath = join(dir, ".plans", "1", "_aligndev", "run.md");
  });

  async function status(tokens: string[], stub?: AlignfirstStub): Promise<string> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "status", ...tokens],
      home: dir,
      stub,
      stdout,
      stderr,
    });
    expect(code, stderr.text()).toBe(0);
    return stdout.text();
  }

  it("reads status without loading invalid settings", async () => {
    const settingsPath = join(dir, ".alignfirst", "aligndev.settings.json");
    writeFileSync(settingsPath, "bad json");
    writeInitialSessionFile(sessionFilePath, statusFrontmatter({ ticket: "1" }));
    applyCompletion(sessionFilePath, {
      status: "succeeded",
      exitReason: "completed",
      endedAt: "2026-08-29T11:56:29.000Z",
      sessionId: "sess-42",
      result: "substantive report",
    });
    expect(await status([sessionFilePath, "--result"])).toContain(
      `${RESULT_MARKER}\nsubstantive report\n`,
    );
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
        home: dir,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain(settingsPath);
    expect(listSessionRecords(join(dir, ".plans"), readMachineId(dir))).toHaveLength(1);
  });

  it("returns only metadata and the authoritative result for every selector", async () => {
    const path = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
    const unticketed = join(dir, ".plans", "_aligndev", "20260829-115529.md");
    for (const file of [path, unticketed]) {
      writeInitialSessionFile(
        file,
        statusFrontmatter({ status: "running", pid: process.pid, meta: "run-key" }),
      );
      appendTranscript(file, `internal transcript${RESULT_MARKER}\nechoed earlier result\n`);
      applyCompletion(file, {
        status: "failed",
        exitReason: "error",
        endedAt: "2026-08-29T11:56:29.000Z",
        sessionId: "sess-42",
        result: "final answer",
      });
    }
    const stub = writeAlignfirstStub(makeTempDir(), dir);
    for (const target of [[path], ["--ticket", "1"], ["--no-ticket"], ["--meta", "run-key"]]) {
      const metadata = await status(target, stub);
      const result = await status([...target, "--result"], stub);
      expect(metadata).not.toContain(RESULT_MARKER);
      expect(result).toBe(`${metadata}${RESULT_MARKER}\nfinal answer\n`);
    }
  });

  it("omits an echoed Result marker while running and leaves the file untouched", async () => {
    writeInitialSessionFile(
      sessionFilePath,
      statusFrontmatter({ status: "running", pid: process.pid, machineId: readMachineId(dir) }),
    );
    appendTranscript(sessionFilePath, `internal transcript${RESULT_MARKER}\nnot final\n`);
    const before = readFileSync(sessionFilePath, "utf8");
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("status: running\n");
    expect(output).not.toContain(RESULT_MARKER);
    expect(readFileSync(sessionFilePath, "utf8")).toBe(before);
  });

  it("keeps a terminal file without a Result block metadata-only", async () => {
    writeInitialSessionFile(sessionFilePath, statusFrontmatter({}));
    expect(await status([sessionFilePath, "--result"])).not.toContain(RESULT_MARKER);
  });

  it("returns the reconciled result instead of a stale running echoed marker", async () => {
    writeInitialSessionFile(
      sessionFilePath,
      statusFrontmatter({ status: "running", pid: 2147483647, machineId: readMachineId(dir) }),
    );
    appendTranscript(sessionFilePath, `${RESULT_MARKER}\nnot final\n`);
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("exitReason: terminated\n");
    expect(output).toContain(RESULT_MARKER);
    expect(output).not.toContain("not final");
    expect(readCompletion(sessionFilePath).frontmatter.exitReason).toBe("terminated");
  });

  it("seals a dead running log under its completed name and resolves the retained path", async () => {
    const runningPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529.running.md");
    const completedPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
    writeInitialSessionFile(
      runningPath,
      statusFrontmatter({ status: "running", pid: 2147483647, machineId: readMachineId(dir) }),
    );
    const stub = writeAlignfirstStub(makeTempDir(), dir);
    const target = [".plans/1/_aligndev/20260829-115529.running.md"];
    expect(await status(target, stub)).toContain(
      "sessionFile: .plans/1/_aligndev/20260829-115529.md\n",
    );
    expect(existsSync(runningPath)).toBe(false);
    expect(readCompletion(completedPath).frontmatter.status).toBe("failed");
    expect(await status(target, stub)).toContain(
      "sessionFile: .plans/1/_aligndev/20260829-115529.md\n",
    );
  });

  it.each<[string, () => { target: string; protectedFile?: string; options?: StubOptions }]>([
    [
      "a file outside the session tree",
      () => {
        writeInitialSessionFile(join(dir, "notes.md"), statusFrontmatter({}));
        return { target: "notes.md", protectedFile: join(dir, "notes.md") };
      },
    ],
    ["a missing session file", () => ({ target: ".plans/1/_aligndev/run.md" })],
    [
      "a symlink that resolves outside .plans",
      () => {
        mkdirSync(join(dir, ".plans", "1", "_aligndev"), { recursive: true });
        const outside = join(dir, "outside.md");
        writeInitialSessionFile(outside, statusFrontmatter({}));
        symlinkSync(outside, sessionFilePath);
        return { target: ".plans/1/_aligndev/run.md", protectedFile: outside };
      },
    ],
    [
      "a project file while the sessions live in the companion",
      () => {
        writeInitialSessionFile(sessionFilePath, statusFrontmatter({ ticket: "1" }));
        return {
          target: ".plans/1/_aligndev/run.md",
          protectedFile: sessionFilePath,
          options: {
            companion: { dir: join(dir, "companion"), items: { _aligndev: "companion" } },
          },
        };
      },
    ],
  ])("rejects %s", async (_name, setup) => {
    const { target, protectedFile, options } = setup();
    const before = protectedFile === undefined ? undefined : readFileSync(protectedFile);
    const code = await main({
      argv: ["node", "aligndev", "code", "status", target],
      home: dir,
      stub: writeAlignfirstStub(makeTempDir(), dir, options),
      stderr: makeSink(),
    });
    expect(code).toBe(1);
    if (protectedFile !== undefined) expect(readFileSync(protectedFile)).toEqual(before);
    else expect(existsSync(join(dir, target))).toBe(false);
  });

  it("finds a companion run by ticket and prints its absolute path", async () => {
    const companion = makeTempDir();
    const file = join(companion, ".plans", "29", "_aligndev", "20260829-115529.md");
    writeInitialSessionFile(file, statusFrontmatter({ ticket: "29" }));
    applyCompletion(file, {
      status: "succeeded",
      exitReason: "completed",
      endedAt: "2026-08-29T11:56:29Z",
      sessionId: "sess-42",
      result: "companion answer",
    });
    const stub = writeAlignfirstStub(makeTempDir(), dir, {
      companion: { dir: companion, items: { _aligndev: "companion" } },
    });
    const output = await status(["--ticket", "29", "--result"], stub);
    expect(output).toContain(`sessionFile: ${file}\n`);
    expect(output).toContain(`${RESULT_MARKER}\ncompanion answer\n`);
  });

  it("finds each meta run from any worktree sharing the sessions tree", async () => {
    const sessions = join(dir, "shared");
    const worktrees = [join(dir, "main"), join(dir, "other")];
    for (const [index, meta] of ["run-first", "run-second"].entries()) {
      mkdirSync(worktrees[index]);
      const file = join(sessions, ".plans", "_aligndev", `20260829-11553${index}.md`);
      writeInitialSessionFile(
        file,
        statusFrontmatter({
          meta,
          cwd: worktrees[index],
          startedAt: `2026-08-29T11:55:3${index}.000Z`,
        }),
      );
      applyCompletion(file, {
        status: "succeeded",
        exitReason: "completed",
        endedAt: "2026-08-29T11:56:00Z",
        sessionId: meta,
        result: `answer ${meta}`,
      });
    }
    for (const cwd of worktrees) {
      const stub = writeAlignfirstStub(makeTempDir(), cwd, {
        companion: { dir: sessions, items: { _aligndev: "companion" } },
      });
      for (const meta of ["run-first", "run-second"]) {
        const stdout = makeSink();
        const code = await main({
          argv: ["node", "aligndev", "code", "status", "--meta", meta, "--result"],
          cwd,
          home: dir,
          stub,
          stdout,
        });
        expect(code).toBe(0);
        expect(stdout.text()).toContain(`${RESULT_MARKER}\nanswer ${meta}\n`);
      }
    }
  });
});

describe("quota", () => {
  it("reads the quota without a plans directory or model discovery", async () => {
    const stdout = makeSink();
    const modelResolver = vi.fn(async () => {
      throw new Error("quota must not discover models");
    });
    const quotaReader = vi.fn(async () => "Claude Code quota\n\nCurrent session: 25% used");
    const cwd = makeTempDir();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "quota"],
        cwd,
        env: { KEEP: "yes" },
        home: makeHome({ code: { harness: "claude", unset: ["SECRET"] } }),
        stdout,
        modelResolver,
        quotaReader,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("Claude Code quota\n\nCurrent session: 25% used");
    expect(quotaReader).toHaveBeenCalledWith("claude", {
      cwd,
      env: expect.objectContaining({ KEEP: "yes", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" }),
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
        argv: ["node", "aligndev", "code", "quota"],
        env: {},
        home: makeHome({ code: { harness: "codex" } }),
        stderr,
        quotaReader,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("limits unavailable");
  });
});

describe("resolveTicket", () => {
  function record(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return {
      path: "/proj/.plans/30/_aligndev/r.md",
      frontmatter: statusFrontmatter({ sessionId: "abc", ticket: "30", ...overrides }),
    };
  }

  it("prefers the explicit --ticket over resume inheritance and message inference", () => {
    const withResume = parse(["resume", "abc", "--ticket", "9", "--message", "m"]);
    expect(resolveTicket(withResume, [record({})])).toBe("9");

    const withMessage = parse(["new", "--ticket", "9", "--message", "See .plans/2/B2-plan.md"]);
    expect(resolveTicket(withMessage, [])).toBe("9");
  });

  it("resume inherits the latest run's ticket, including null", () => {
    const resume = parse(["resume", "abc", "--message", "m"]);
    const records = [
      record({ ticket: "30", startedAt: "2026-07-01T09:00:00.000Z" }),
      record({ ticket: "31", startedAt: "2026-07-01T10:00:00.000Z" }),
      record({ ticket: "99", sessionId: "other", startedAt: "2026-07-01T12:00:00.000Z" }),
    ];
    expect(resolveTicket(resume, records)).toBe("31");
    const unticketed = record({ ticket: null, startedAt: "2026-07-01T11:00:00.000Z" });
    expect(resolveTicket(resume, [...records, unticketed])).toBeUndefined();
  });

  it.each([
    ["Execute the plan: .plans/2/B2-plan.md", "2"],
    ["Read .plans/2/a.md then .plans/2/b.md", "2"],
    ["See .plans/_aligndev/20260706-122913.md", undefined],
    ["Compare .plans/2/a.md with .plans/3/b.md", undefined],
  ])("infers the ticket of %j", (message, expected) => {
    expect(resolveTicket(parse(["new", "--message", message]), [])).toBe(expected);
  });

  it("yields no ticket for a new run without a message", () => {
    expect(resolveTicket(parse(["new"]), [])).toBeUndefined();
  });
});

describe("buildRunConfig", () => {
  useProjectFixtures();

  const CODE: CodeConfig = {
    harness: "claude",
    profile: null,
    childEnv: {},
    skipPermissions: false,
    unset: [],
  };

  function build(overrides: Partial<RunInput>): RunConfig {
    return buildRunConfig({
      args: parse(["new", "--message", "go"]),
      code: CODE,
      report: reportWithCompanion([]),
      ticket: undefined,
      cwd: "/proj",
      sessionFilePath: "/proj/.plans/_aligndev/s.md",
      executableModel: undefined,
      effort: undefined,
      alignfirst: "alignfirst",
      env: process.env,
      ...overrides,
    });
  }

  it("puts the effective ticket, not the flag, in the prompt", () => {
    const config = build({
      args: parse(["resume", "abc", "--protocol", "plan", "--ticket", "flag-99"]),
      ticket: "effective-30",
    });
    expect(config.prompt).toContain("effective-30");
    expect(config.prompt).not.toContain("flag-99");
  });

  it("adds the companion as a writable directory, whatever it holds", () => {
    for (const items of [[], ["_aligndev"], [".plans"]] satisfies ItemName[][]) {
      const report = reportWithCompanion(items);
      expect(build({ report }).additionalDirectories).toEqual(["/companions/proj"]);
    }
  });

  it("adds a linked worktree's git common directory after the companion, for Antigravity", () => {
    const fixture = makeFixture();
    const main = makeRepository(fixture.root, "app");
    addInitialCommit(main);
    const cwd = join(fixture.root, "app-feature");
    addWorktree(main, cwd, "feature");
    const agy = build({ code: { ...CODE, harness: "agy" }, cwd });
    expect(agy.additionalDirectories).toEqual(["/companions/proj", join(main, ".git")]);
    expect(build({ cwd }).additionalDirectories).toEqual(["/companions/proj"]);
  });

  it("adds no directory without a companion, or with skipPermissions", () => {
    const report = { ...reportWithCompanion([]), companion: null };
    expect(build({ report }).additionalDirectories).toEqual([]);
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
    workspace: {
      location: { path: "/proj/alignfirst.json", in: "project", exists: false },
      registryDir: "/proj/.local-wt/workspace-registry",
      runtimeDir: "/proj/.local-wt",
      schemaVersion: null,
      portRange: null,
      hasDevServer: false,
    },
    config: null,
    companion: {
      dir: "/companions/proj",
      exists: true,
      defaultLocation: "auto",
      items: {
        alignfirst: "auto",
        ".alignfirst-instructions": "auto",
        assistantInstructionsFile: "auto",
        workspaceRuntime: "auto",
        docs: "auto",
        ".plans": "auto",
        _aligndev: "auto",
      },
    },
    selectionOrigins: {
      alignfirst: "builtin",
      ".alignfirst-instructions": "builtin",
      assistantInstructionsFile: "builtin",
      workspaceRuntime: "builtin",
      docs: "builtin",
      ".plans": "builtin",
      _aligndev: "builtin",
    },
    aligndev: null,
    locations: {
      alignfirst: location("alignfirst.json", "alignfirst"),
      ".alignfirst-instructions": location(".alignfirst-instructions", ".alignfirst-instructions"),
      assistantInstructionsFile: location("DEVELOPERS.md", "assistantInstructionsFile"),
      workspaceRuntime: location(".local-wt", "workspaceRuntime"),
      docs: location("docs", "docs"),
      ".plans": location(".plans", ".plans"),
      _aligndev: location(".plans", "_aligndev"),
    },
  };
}

describe("checkLaunchGuards", () => {
  const MACHINE = "this-machine";
  const CWD = realpathSync(mkdtempSync(join(tmpdir(), "aligndev-guards-")));
  const ALIAS = `${CWD}-alias`;
  const OTHER = realpathSync(mkdtempSync(join(tmpdir(), "aligndev-guards-other-")));
  symlinkSync(CWD, ALIAS);
  afterAll(() => {
    for (const path of [CWD, ALIAS, OTHER]) rmSync(path, { recursive: true, force: true });
  });

  function running(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return {
      path: `/sessions/${overrides.sessionId ?? "run"}.md`,
      frontmatter: statusFrontmatter({
        status: "running",
        protocol: "spec",
        ticket: "30",
        pid: process.pid,
        machineId: MACHINE,
        cwd: CWD,
        sessionId: "abc",
        ...overrides,
      }),
    };
  }

  function done(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return running({ status: "succeeded", pid: null, ...overrides });
  }

  const RESUME = ["resume", "abc", "-m", "go"];
  const PLAN_31 = ["new", "--protocol", "plan", "--ticket", "31"];

  it.each<[string, string[], CodingAgent, string | undefined, SessionRecord[]]>([
    ["an unknown resume id", ["resume", "zzz", "-m", "go"], "claude", undefined, [done({})]],
    ["a resume without records", RESUME, "claude", undefined, []],
    ["a resume of a running session", RESUME, "claude", undefined, [running({})]],
    [
      "a resume blocked by a dead record of another machine",
      RESUME,
      "claude",
      undefined,
      [running({ pid: 2147483647, machineId: "another-machine" })],
    ],
    [
      "a protocol run blocked by a dead record without a machine",
      PLAN_31,
      "claude",
      "31",
      [running({ pid: 2147483647, machineId: null })],
    ],
    ["a legacy resume", RESUME, "claude", undefined, [done({ agent: null })]],
    ["a cross-agent resume", RESUME, "claude", undefined, [done({ agent: "codex" })]],
    [
      "a resume from another real worktree",
      RESUME,
      "pi",
      undefined,
      [done({ agent: "pi", cwd: OTHER })],
    ],
    ["a protocol run in a busy worktree", PLAN_31, "claude", "31", [running({})]],
    [
      "a protocol run on a ticket busy in another worktree",
      PLAN_31,
      "claude",
      "31",
      [running({ ticket: "31", cwd: "/elsewhere" })],
    ],
  ])("rejects %s", (_name, tokens, agent, ticket, records) => {
    expect(checkLaunchGuards(parse(tokens), agent, CWD, ticket, records, MACHINE)).toBeDefined();
  });

  it.each<[string, string[], string | undefined, SessionRecord[]]>([
    [
      "a protocol run beside another worktree's run",
      PLAN_31,
      "31",
      [running({ cwd: "/elsewhere" })],
    ],
    ["a protocol run beside a plain run", PLAN_31, "31", [running({ protocol: null })]],
    [
      "a protocol run beside a plain resume on its ticket",
      ["new", "--protocol", "plan", "--ticket", "30"],
      "30",
      [running({ protocol: null })],
    ],
    [
      "a --no-ticket protocol run beside another worktree's run",
      ["new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      undefined,
      [running({ cwd: "/elsewhere" })],
    ],
    [
      "a plain resume in a busy worktree",
      ["resume", "done", "-m", "answer"],
      undefined,
      [running({}), done({ sessionId: "done" })],
    ],
    [
      "a plain new run in a busy worktree",
      ["new", "-m", "Execute the plan"],
      undefined,
      [running({})],
    ],
    [
      "a resume from the latest recorded cwd through a symlink alias",
      RESUME,
      undefined,
      [
        done({ agent: "pi", cwd: OTHER, startedAt: "2020-01-01T00:00:00.000Z" }),
        done({ agent: "pi", cwd: ALIAS }),
      ],
    ],
  ])("allows %s", (_name, tokens, ticket, records) => {
    const agent = records.some((record) => record.frontmatter.agent === "pi") ? "pi" : "claude";
    expect(checkLaunchGuards(parse(tokens), agent, CWD, ticket, records, MACHINE)).toBeUndefined();
  });
});

describe("launches", () => {
  let base: string;
  let home: string;
  let project: string;
  let plans: string;
  beforeEach(() => {
    base = makeTempDir();
    home = join(base, "home");
    project = join(base, "project");
    plans = join(project, ".plans");
    mkdirSync(plans, { recursive: true });
    writeConfig(home, { code: { harness: "claude" } });
  });

  async function launch(
    tokens: string[],
    options: Partial<MainOptions> & { stub?: AlignfirstStub } = {},
  ) {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", ...tokens],
      cwd: project,
      home,
      modelResolver: async (_agent, model) => model,
      ...options,
      stub: options.stub ?? writeAlignfirstStub(base, project),
      stdout,
      stderr,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  function newest(): SessionRecord {
    return listSessionRecords(plans, readMachineId(home)).reduce((a, b) =>
      a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b,
    );
  }

  it("records the side ticket alignfirst reserves for --no-ticket", async () => {
    const result = await launch(["new", "--protocol", "aad", "--no-ticket", "-m", "go"], {
      stub: writeAlignfirstStub(base, project, { sideTicket: "side-7" }),
      modelResolver: async () => {
        throw new Error("stop before spawning");
      },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`Session file: ${join(".plans", "side-7", "_aligndev")}`);
    expect(newest().frontmatter).toMatchObject({
      ticket: "side-7",
      command: 'aligndev code new --protocol aad --no-ticket --message "go"',
    });
  });

  describe("model selection", () => {
    let fake: FakeAgent;
    beforeEach(() => {
      writeConfig(home, {
        code: { harness: "claude", defaultModel: "sonnet", defaultEffort: "low" },
      });
      fake = installFakeClaude(base);
    });

    // The value of each option the agent received.
    async function received(tokens: string[]) {
      const result = await launch(tokens, { env: { PATH: fake.path } });
      expect(result.code, result.stderr).toBe(0);
      const { args } = fake.received();
      const value = (option: string) =>
        args.includes(option) ? args[args.indexOf(option) + 1] : undefined;
      return { model: value("--model"), effort: value("--effort") };
    }

    it("starts a new session with the profile defaults and records them", async () => {
      expect(await received(["new", "-m", "go"])).toEqual({ model: "sonnet", effort: "low" });
      expect(newest().frontmatter).toMatchObject({
        model: "sonnet",
        effort: "low",
        command: 'aligndev code new --message "go"',
      });
    });

    it("lets --model and --effort override the profile defaults", async () => {
      expect(await received(["new", "-m", "go", "--model", "haiku", "--effort", "max"])).toEqual({
        model: "haiku",
        effort: "max",
      });
      expect(newest().frontmatter).toMatchObject({ model: "haiku", effort: "max" });
    });

    it.each([
      ["haiku", "high"],
      [null, null],
    ])("resumes with the latest run's model %j and effort %j", async (model, effort) => {
      writeInitialSessionFile(
        join(plans, "_aligndev", "old.md"),
        statusFrontmatter({
          sessionId: "abc",
          profile: "test",
          model: "opus",
          effort: "max",
          startedAt: "2026-08-29T10:00:00.000Z",
        }),
      );
      writeInitialSessionFile(
        join(plans, "_aligndev", "latest.md"),
        statusFrontmatter({ sessionId: "abc", profile: "test", model, effort }),
      );
      expect(await received(["resume", "abc", "-m", "more"])).toEqual({
        model: model ?? undefined,
        effort: effort ?? undefined,
      });
      expect(newest().frontmatter).toMatchObject({ model, effort });
    });
  });

  describe("companion projects", () => {
    const companion = () => join(base, "companion");

    it("adds the companion directory and the project context for the agent", async () => {
      mkdirSync(join(companion(), ".plans"), { recursive: true });
      const stub = writeAlignfirstStub(base, project, {
        companion: { dir: companion(), items: { ".plans": "companion" } },
      });
      const fake = installFakeClaude(base);

      const started = await launch(["new", "-m", "go"], { stub, env: { PATH: fake.path } });
      expect(started.code, started.stderr).toBe(0);
      const first = fake.received();
      expect(first.prompt).toContain("alignfirst context output");
      expect(first.prompt).toMatch(/go$/);
      expect(first.args).toEqual(expect.arrayContaining(["--add-dir", companion()]));

      const resumed = await launch(["resume", "session-1", "-m", "more"], {
        stub,
        env: { PATH: fake.path },
      });
      expect(resumed.code, resumed.stderr).toBe(0);
      const second = fake.received();
      expect(second.prompt).toBe("more");
      expect(second.args).toEqual(expect.arrayContaining(["--add-dir", companion()]));
    });

    it("adds the companion without the project context when it holds only sessions", async () => {
      mkdirSync(join(companion(), ".plans"), { recursive: true });
      const stub = writeAlignfirstStub(base, project, {
        companion: { dir: companion(), items: { _aligndev: "companion" } },
      });
      const fake = installFakeClaude(base);
      const started = await launch(["new", "-m", "go"], { stub, env: { PATH: fake.path } });
      expect(started.code, started.stderr).toBe(0);
      const { prompt, args } = fake.received();
      expect(prompt).not.toContain("alignfirst context output");
      expect(args).toEqual(expect.arrayContaining(["--add-dir", companion()]));
    });

    it("creates a missing companion directory before adding it", async () => {
      const stub = writeAlignfirstStub(base, project, {
        companion: { dir: companion(), items: { ".plans": "project" } },
      });
      const fake = installFakeClaude(base);
      const started = await launch(["new", "-m", "go"], { stub, env: { PATH: fake.path } });
      expect(started.code, started.stderr).toBe(0);
      expect(existsSync(companion())).toBe(true);
      expect(fake.received().args).toEqual(expect.arrayContaining(["--add-dir", companion()]));
    });
  });

  describe("quiet execution", () => {
    async function quietLaunch(tokens: string[], body: string) {
      const fake = installFakeClaude(base, body);
      const result = await launch(tokens, { env: { PATH: fake.path } });
      const record = newest();
      return { ...result, file: record.path, completion: readCompletion(record.path) };
    }

    it("retains control lines on quiet new/resume and records the flag", async () => {
      const body = printJsonLines(
        { type: "assistant", message: { content: [{ type: "text", text: "private transcript" }] } },
        { type: "result", session_id: "session-1", result: "final answer" },
      );
      const started = await quietLaunch(["new", "-m", "go", "--quiet"], body);
      expect(started.code).toBe(0);
      // The code guide consumes both control lines.
      expect(started.stdout.split("\n").filter((line) => line !== "")).toEqual([
        `Session file: ${relative(project, started.file).replace(/\.md$/, ".running.md")}`,
        "Session ID: session-1",
      ]);
      expect(started.stderr).toBe("");
      expect(started.completion.result).toBe("final answer");
      expect(started.completion.frontmatter.command).toContain("--quiet");
      expect(readFileSync(started.file, "utf8")).toContain("private transcript");
      const resumed = await quietLaunch(["resume", "session-1", "-m", "more", "--quiet"], body);
      expect(resumed.code).toBe(0);
      expect(resumed.stdout.split("\n").filter((line) => line !== "")).toEqual([
        `Session file: ${relative(project, resumed.file).replace(/\.md$/, ".running.md")}`,
      ]);
      expect(resumed.completion.frontmatter.command).toContain("--quiet");
    });

    it.each([
      [
        "stderr",
        `printf '%s' ${quote("service unavailable: credential-must-stay-private".repeat(200))} >&2\nexit 7`,
      ],
      [
        "incomplete",
        printJsonLines({
          type: "assistant",
          message: { content: [{ type: "text", text: "internal-only" }] },
        }),
      ],
    ])("keeps %s failures durable with bounded quiet diagnostics", async (_name, body) => {
      const result = await quietLaunch(["new", "-m", "go", "--quiet"], body);
      expect(result.code).toBe(1);
      expect(result.completion.frontmatter).toMatchObject({
        status: "failed",
        exitReason: "error",
      });
      expect(result.stderr).toContain(`Session file: ${relative(project, result.file)}\n`);
      expect(result.stderr).not.toContain("credential-must-stay-private");
      expect(result.stdout).not.toContain("internal-only");
      expect(result.stdout.length + result.stderr.length).toBeLessThan(700);
    });

    it("keeps authentication exit 2 and records the login command in the durable result", async () => {
      const result = await quietLaunch(
        ["new", "-m", "go", "--quiet"],
        printJsonLines(
          { type: "assistant", error: "authentication_failed" },
          { type: "result", is_error: true, result: "credential-must-stay-private".repeat(200) },
        ),
      );
      expect(result.code).toBe(2);
      expect(result.completion.frontmatter).toMatchObject({
        status: "failed",
        exitReason: "auth_required",
      });
      expect(result.stderr).not.toContain("credential-must-stay-private");
      expect(result.stdout.length + result.stderr.length).toBeLessThan(1500);
      const login = result.stderr.split("\n").find((line) => line.includes(project));
      expect(login).toBeDefined();
      expect(result.completion.result).toContain(login);
    });
  });

  describe("pi", () => {
    let fake: FakeAgent;
    beforeEach(() => {
      writeConfig(home, { code: { harness: "pi" } });
      fake = installFakeAgent(
        base,
        "pi",
        `printf '{"type":"session","version":3,"id":"pi-session","cwd":"%s","timestamp":"2026-08-29T11:55:29.000Z"}\\n' "$(pwd)"
${printJsonLines(
  {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "private pi answer" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
  },
  { type: "agent_settled", aborted: false },
)}`,
      );
    });

    it("starts quietly with native selectors and resumes the exact session with inherited models", async () => {
      const selected = "provider/model:high";
      const env = { PATH: fake.path };
      const first = await launch(["new", "-m", "go", "--model", selected, "--quiet"], { env });
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain("Session ID: pi-session");
      expect(first.stdout).not.toContain("private pi answer");
      expect(fake.received().args).toEqual(["--mode", "json", "--model", selected]);
      expect(fake.received().prompt).toMatch(/go$/);
      expect(readCompletion(newest().path)).toMatchObject({
        frontmatter: { agent: "pi", model: selected },
        result: "private pi answer",
      });
      writeConfig(home, {
        code: { harness: "pi", models: [selected, "other/model"], defaultModel: "other/model" },
      });
      const resumed = await launch(["resume", "pi-session", "-m", "more", "--quiet"], { env });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(fake.received().args).toEqual([
        "--mode",
        "json",
        "--model",
        selected,
        "--session",
        "pi-session",
      ]);
      expect(newest().frontmatter.model).toBe(selected);
    });

    it("prepares a missing companion only on launch", async () => {
      const companion = join(base, "companion");
      const stub = writeAlignfirstStub(base, project, {
        companion: { dir: companion, items: { ".plans": "project" } },
      });
      const env = { PATH: fake.path };
      expect((await launch(["status", "--no-ticket"], { stub, env })).code).toBe(1);
      expect(existsSync(companion)).toBe(false);
      const result = await launch(["new", "-m", "go"], { stub, env });
      expect(result.code, result.stderr).toBe(0);
      expect(existsSync(companion)).toBe(true);
      expect(fake.received().args).toEqual(["--mode", "json"]);
    });
  });
});

function statusFrontmatter(overrides: Partial<SessionFrontmatter>): SessionFrontmatter {
  return {
    status: "succeeded",
    agent: "claude",
    profile: null,
    protocol: "review",
    ticket: null,
    model: null,
    effort: null,
    sessionId: "sess-42",
    command: "aligndev code new --protocol review",
    meta: null,
    pid: null,
    pidStartTime: null,
    machineId: "test-machine",
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
