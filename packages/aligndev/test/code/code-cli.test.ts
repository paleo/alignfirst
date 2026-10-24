import { spawnSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { readMachineId } from "../../src/code/machine-id.js";
import { CLAUDE_DEFAULT_MODELS } from "../../src/code/models.js";
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
import {
  ALIGNFIRST_BIN,
  type CompanionProject,
  installGit,
  makeCompanionProject,
  makeSink,
  writeConfig,
} from "../helpers.js";

const ALIGNFIRST = [process.execPath, ALIGNFIRST_BIN];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function main(options: MainOptions): Promise<number> {
  return runMain({
    ...options,
    cwd: options.cwd ?? options.home,
    env: { HOME: options.home, ...options.env },
    alignfirstCommand: options.alignfirstCommand ?? ALIGNFIRST,
  });
}

function parse(tokens: string[]): SessionArgs {
  const command = parseCodeArgs(tokens, "aligndev");
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
  const home = mkdtempSync(join(tmpdir(), "aligndev-home-"));
  tempDirs.push(home);
  if (config !== undefined) writeConfig(home, config);
  return home;
}

describe("coding-agent selection", () => {
  it("requires a configured or detected agent before help", async () => {
    const stderr = makeSink();
    const home = makeHome();
    expect(
      await main({ argv: ["node", "aligndev", "code", "--help"], env: {}, home, stderr }),
    ).toBe(1);
    expect(stderr.text()).toContain("Error: no coding agent detected");
    expect(stderr.text()).toContain('"code.profile"');
  });

  it("rejects an invalid agent in the config", async () => {
    const stderr = makeSink();
    const home = makeHome({ platform: "codingAgent", code: { agent: "other" } });
    expect(
      await main({ argv: ["node", "aligndev", "code", "--help"], env: {}, home, stderr }),
    ).toBe(1);
    expect(stderr.text()).toContain("invalid aligndev config");
    expect(stderr.text()).toContain("agent");
  });

  it("renders only the selected agent's models without discovery", async () => {
    const stdout = makeSink();
    const modelResolver = async () => {
      throw new Error("help must not discover models");
    };
    expect(
      await main({
        argv: ["node", "aligndev", "code", "--help"],
        env: {},
        home: makeHome({ platform: "codingAgent", code: { agent: "codex" } }),
        stdout,
        modelResolver,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("aligndev code new --protocol <protocol>");
    expect(stdout.text()).toContain("code.profile          Global named profile");
    expect(stdout.text()).toContain("(selected: codex)");
    expect(stdout.text()).toContain("astra, sol, terra, luna");
    expect(stdout.text()).toContain("See the `code` topic of `aligndev guide`");
    expect(stdout.text()).toContain("--quiet");
    expect(stdout.text()).toContain("--result");
    expect(stdout.text()).toContain("host owns background execution and completion delivery");
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
    expect(
      await main({ argv: ["node", "aligndev", "code", "--help"], env: {}, home, stdout }),
    ).toBe(0);
    expect(stdout.text()).toContain("One of sonnet, haiku.");
  });
});

describe("parseCodeArgs", () => {
  it("maps the commands and flags", () => {
    expect(parseCodeArgs(["--help"], "aligndev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["-h"], "aligndev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["status", ".plans/1/_aligndev/run.md"], "aligndev")).toEqual({
      kind: "status",
      target: { kind: "file", sessionFile: ".plans/1/_aligndev/run.md" },
      includeResult: false,
    });
    expect(parseCodeArgs(["status", "--ticket", "AB-1"], "aligndev")).toEqual({
      kind: "status",
      target: { kind: "ticket", ticket: "AB-1" },
      includeResult: false,
    });
    expect(parseCodeArgs(["status", "--no-ticket"], "aligndev")).toEqual({
      kind: "status",
      target: { kind: "noTicket" },
      includeResult: false,
    });
    expect(parseCodeArgs(["quota"], "aligndev")).toEqual({ kind: "quota" });
  });

  it("leaves the version and guide flags to other commands", () => {
    for (const flag of ["--version", "-v", "--guide", "--openclaw-guide"]) {
      expect(() => parseCodeArgs([flag], "aligndev")).toThrow(`unknown command "${flag}"`);
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

  it.each([["new"], ["resume", "abc"]])("reads --quiet on %j", (...command) => {
    expect(parse([...command, "-m", "go", "--quiet"]).quiet).toBe(true);
    expect(parse([...command, "-m", "go"]).quiet).toBeUndefined();
    expect(parseCodeArgs([...command, "--quiet", "--help"], "aligndev")).toEqual({ kind: "help" });
  });

  it.each([["run.md"], ["--ticket", "AB-1"], ["--no-ticket"], ["--meta", "unique-run"]])(
    "reads --result independently of the status target %j",
    (...target) => {
      const metadata = parseCodeArgs(["status", ...target], "aligndev");
      const withResult = parseCodeArgs(["status", "--result", ...target], "aligndev");
      expect(withResult).toEqual({ ...metadata, includeResult: true });
    },
  );

  it.each([
    [],
    ["a.md", "b.md"],
    ["a.md", "--meta", "k"],
    ["--ticket", "1", "--no-ticket"],
    ["--ticket", "1", "--meta", "k"],
    ["--no-ticket", "--meta", "k"],
  ])("keeps exactly one status target with --result %j", (...target) => {
    expect(() => parseCodeArgs(["status", "--result", ...target], "aligndev")).toThrow(
      "exactly one",
    );
  });

  it("keeps quiet and result scoped to their commands", () => {
    expect(() => parseCodeArgs(["status", "run.md", "--quiet"], "aligndev")).toThrow();
    expect(() => parse(["new", "-m", "go", "--result"])).toThrow();
    expect(() => parse(["resume", "abc", "-m", "go", "--result"])).toThrow();
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
    expect(parseCodeArgs(["new", "--help"], "aligndev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["resume", "-h"], "aligndev")).toEqual({ kind: "help" });
    expect(parseCodeArgs(["status", "--help"], "aligndev")).toEqual({ kind: "help", status: true });
    expect(parseCodeArgs(["quota", "--help"], "aligndev")).toEqual({ kind: "help" });
  });

  it("rejects a missing or unknown command", () => {
    expect(() => parseCodeArgs([], "aligndev")).toThrow(
      "no command given. Run `aligndev code --help`.",
    );
    expect(() => parseCodeArgs(["spec"], "aligndev")).toThrow('unknown command "spec"');
    expect(() => parseCodeArgs(["--new"], "aligndev")).toThrow('unknown command "--new"');
  });

  it("rejects unknown options, stray positionals, and a resume without an id", () => {
    expect(() => parse(["new", "--nope"])).toThrow();
    expect(() => parse(["new", "extra", "-m", "go"])).toThrow();
    const statusTargetError = "exactly one of <session-file>, --ticket <id>, --no-ticket";
    expect(() => parseCodeArgs(["status"], "aligndev")).toThrow(statusTargetError);
    expect(() => parseCodeArgs(["status", "x.md", "--ticket", "1"], "aligndev")).toThrow(
      statusTargetError,
    );
    expect(() => parseCodeArgs(["status", "--ticket", "1", "--no-ticket"], "aligndev")).toThrow(
      statusTargetError,
    );
    expect(() => parseCodeArgs(["status", "--ticket", "../other"], "aligndev")).toThrow(
      "--ticket must be a single path segment",
    );
    expect(() => parseCodeArgs(["status", "--meta", "k", "--no-ticket"], "aligndev")).toThrow(
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
    dir = mkdtempSync(join(tmpdir(), "aligndev-status-"));
    writeConfig(dir, { platform: "codingAgent", code: { agent: "claude" } });
    sessionFilePath = join(dir, ".plans", "1", "_aligndev", "run.md");
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
      profile: null,
      protocol: "review",
      ticket,
      model: null,
      sessionId: "sess-42",
      command: "aligndev code new --protocol review --ticket 1",
      meta: null,
      pid,
      pidStartTime: null,
      machineId: readMachineId(dir),
      cwd: dir,
      startedAt: "2026-08-29T11:55:29.000Z",
      endedAt: null,
      exitReason: null,
      contextTokens: 162_400,
      contextCompacted: false,
      contextTokensError: null,
    });
  }

  async function status(tokens: string[]): Promise<string> {
    const stdout = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "status", ...tokens],
      cwd: dir,
      env: { HOME: dir },
      home: dir,
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr: makeSink(),
    });
    expect(code).toBe(0);
    return stdout.text();
  }

  it.each([
    "bad json",
    JSON.stringify({ code: { agent: "claude" } }),
    JSON.stringify({ code: { profile: "gone", profiles: {} } }),
  ])("reads status without loading invalid settings: %s", async (settings) => {
    const settingsPath = join(dir, ".alignfirst", "aligndev.settings.json");
    writeFileSync(settingsPath, settings);
    writeStatusRecord(process.pid);
    const result = "substantive report\n\n---- Later result ----\n\nacknowledgement";
    applyCompletion(sessionFilePath, {
      status: "succeeded",
      exitReason: "completed",
      endedAt: "2026-08-29T11:56:29.000Z",
      sessionId: "sess-42",
      result,
    });
    const before = readFileSync(settingsPath);
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("status: succeeded\n");
    expect(output).toContain(`${RESULT_MARKER}\n${result}\n`);
    expect(await status(["--help"])).toContain("without reading settings");
    expect(readFileSync(settingsPath)).toEqual(before);
    const records = listSessionRecords(join(dir, ".plans"), readMachineId(dir));
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout: makeSink(),
        stderr,
      }),
    ).toBe(1);
    if (settings.includes("gone")) expect(stderr.text()).toContain("gone");
    else expect(stderr.text()).toContain(settingsPath);
    expect(listSessionRecords(join(dir, ".plans"), readMachineId(dir))).toEqual(records);
    expect(readFileSync(settingsPath)).toEqual(before);
  });

  it.each(["succeeded", "failed"] as const)(
    "returns only metadata and the authoritative %s result for every selector",
    async (terminalStatus) => {
      const path = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
      const unticketed = join(dir, ".plans", "_aligndev", "20260829-115529.md");
      for (const file of [path, unticketed]) {
        writeInitialSessionFile(
          file,
          statusFrontmatter({ status: "running", pid: process.pid, meta: "run-key" }),
        );
        appendTranscript(file, `internal transcript${RESULT_MARKER}\nechoed earlier result\n`);
        applyCompletion(file, {
          status: terminalStatus,
          exitReason: terminalStatus === "succeeded" ? "completed" : "error",
          endedAt: "2026-08-29T11:56:29.000Z",
          sessionId: "sess-42",
          result: "final answer",
        });
      }
      for (const target of [[path], ["--ticket", "1"], ["--no-ticket"], ["--meta", "run-key"]]) {
        const metadata = await status(target);
        const result = await status([...target, "--result"]);
        expect(metadata).not.toContain(RESULT_MARKER);
        expect(result).toBe(`${metadata}${RESULT_MARKER}\nfinal answer\n`);
        expect(result).not.toContain("internal transcript");
        expect(result).not.toContain("echoed earlier result");
      }
    },
  );

  it("omits an echoed Result marker while running and leaves the file untouched", async () => {
    writeStatusRecord(process.pid);
    appendTranscript(sessionFilePath, `internal transcript${RESULT_MARKER}\nnot final\n`);
    const before = readFileSync(sessionFilePath, "utf8");
    expect(readCompletion(sessionFilePath).result).toBe("not final");
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("status: running\n");
    expect(output).not.toContain(RESULT_MARKER);
    expect(output).not.toContain("not final");
    expect(readFileSync(sessionFilePath, "utf8")).toBe(before);
  });

  it("returns the reconciled result instead of a stale running echoed marker", async () => {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    writeInitialSessionFile(
      sessionFilePath,
      statusFrontmatter({
        status: "running",
        pid: child.pid,
        machineId: readMachineId(dir),
      }),
    );
    appendTranscript(sessionFilePath, `${RESULT_MARKER}\nnot final\n`);
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("status: failed\n");
    expect(output).toContain("exitReason: terminated\n");
    expect(output).toContain(`${RESULT_MARKER}\nSealed as interrupted:`);
    expect(output).not.toContain("not final");
    expect(readCompletion(sessionFilePath).result).toContain("is gone");
  });

  it.each(["another-machine", null])(
    "preserves dead running records owned by %j for every status selector",
    async (machineId) => {
      const child = spawnSync("node", ["-e", ""]);
      if (child.pid === undefined) throw new Error("failed to spawn a probe child");
      const path = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
      const noTicket = join(dir, ".plans", "_aligndev", "20260829-115529.md");
      for (const file of [path, noTicket]) {
        writeInitialSessionFile(
          file,
          statusFrontmatter({
            status: "running",
            pid: child.pid,
            machineId,
            meta: "owner-check",
          }),
        );
      }
      const before = readFileSync(path, "utf8");
      const beforeNoTicket = readFileSync(noTicket, "utf8");
      for (const target of [
        [path],
        ["--ticket", "1"],
        ["--no-ticket"],
        ["--meta", "owner-check"],
      ]) {
        const output = await status([...target, "--result"]);
        expect(output).toContain(`pid: ${child.pid}\nmachineId: ${machineId ?? ""}\n`);
        expect(output).toContain("status: running\n");
        expect(output).not.toContain(RESULT_MARKER);
      }
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readFileSync(noTicket, "utf8")).toBe(beforeNoTicket);
    },
  );

  it("leaves its own running record without a pid untouched", async () => {
    writeInitialSessionFile(
      sessionFilePath,
      statusFrontmatter({
        status: "running",
        pid: null,
        machineId: readMachineId(dir),
      }),
    );
    const before = readFileSync(sessionFilePath, "utf8");
    const output = await status([sessionFilePath, "--result"]);
    expect(output).toContain("status: running\n");
    expect(output).toContain(`pid: \nmachineId: ${readMachineId(dir)}\n`);
    expect(output).not.toContain(RESULT_MARKER);
    expect(readFileSync(sessionFilePath, "utf8")).toBe(before);
  });

  it("keeps terminal files without a Result block metadata-only", async () => {
    writeInitialSessionFile(sessionFilePath, statusFrontmatter({}));
    expect(await status([sessionFilePath, "--result"])).not.toContain(RESULT_MARKER);
  });

  it("reconciles and reports a dead run without a coding agent", async () => {
    const child = spawnSync("node", ["-e", ""]);
    if (child.pid === undefined) throw new Error("failed to spawn a probe child");
    writeStatusRecord(child.pid);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", ".plans/1/_aligndev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain(
      "sessionFile: .plans/1/_aligndev/run.md\nsessionId: sess-42\nagent: claude\nprofile: \nmodel: \nstatus: failed\n",
    );
    expect(stdout.text()).toContain(`pid: ${child.pid}\nmachineId: ${readMachineId(dir)}\n`);
    expect(stdout.text()).toContain("exitReason: terminated\n");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("seals a dead running log under its completed name and resolves the retained path", async () => {
    const runningPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529.running.md");
    const completedPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
    writeStatusRecord(2147483647, runningPath);
    const stdout = makeSink();
    const options = {
      argv: ["node", "aligndev", "code", "status", ".plans/1/_aligndev/20260829-115529.running.md"],
      cwd: dir,
      env: { HOME: dir },
      home: dir,
      alignfirstCommand: ALIGNFIRST,
      stdout,
    };
    expect(await main(options)).toBe(0);
    expect(stdout.text()).toContain("sessionFile: .plans/1/_aligndev/20260829-115529.md\n");
    expect(stdout.text()).toContain("exitReason: terminated\n");
    expect(existsSync(runningPath)).toBe(false);
    expect(readCompletion(completedPath).frontmatter.status).toBe("failed");
    // The retained running path keeps working once the run has ended.
    expect(await main(options)).toBe(0);
    expect(stdout.text()).toContain(
      "sessionFile: .plans/1/_aligndev/20260829-115529.md\nsessionId",
    );
  });

  it("reports a live run without changing its record", async () => {
    writeStatusRecord(process.pid);
    const stdout = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", ".plans/1/_aligndev/run.md"],
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
    const firstPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529.md");
    const secondPath = join(dir, ".plans", "1", "_aligndev", "20260829-115529-2.md");
    writeStatusRecord(process.pid, firstPath);
    writeStatusRecord(process.pid, secondPath);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", "--ticket", "1"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("sessionFile: .plans/1/_aligndev/20260829-115529-2.md\n");
  });

  it("selects the newest no-ticket run", async () => {
    const noTicketPath = join(dir, ".plans", "_aligndev", "20260829-115529.md");
    writeStatusRecord(process.pid, noTicketPath, null);
    const stdout = makeSink();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", "--no-ticket"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain("sessionFile: .plans/_aligndev/20260829-115529.md\n");
  });

  it("reports an empty scoped session directory", async () => {
    mkdirSync(join(dir, ".plans", "1", "_aligndev"), { recursive: true });
    const stderr = makeSink();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", "--ticket", "1"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("Error: no session file under .plans/1/_aligndev/.\n");
  });

  it("rejects files outside the session-record tree", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", "notes.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      "Error: status requires a session file under .plans/_aligndev/ or .plans/<ticket>/_aligndev/.\n",
    );
  });

  it("reports a missing session file in its own words", async () => {
    const stderr = makeSink();
    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", ".plans/1/_aligndev/run.md"],
        cwd: dir,
        env: { HOME: dir },
        home: dir,
        alignfirstCommand: ALIGNFIRST,
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe("Error: session file not found: .plans/1/_aligndev/run.md\n");
  });

  it("rejects a session-path symlink that resolves outside .plans", async () => {
    mkdirSync(join(dir, ".plans", "1", "_aligndev"), { recursive: true });
    const outsidePath = join(dir, "outside.md");
    writeFileSync(outsidePath, "keep me");
    symlinkSync(outsidePath, sessionFilePath);
    const stderr = makeSink();

    expect(
      await main({
        argv: ["node", "aligndev", "code", "status", ".plans/1/_aligndev/run.md"],
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
        argv: ["node", "aligndev", "code", "quota"],
        cwd: tmpdir(),
        env: { KEEP: "yes" },
        home: makeHome({ platform: "codingAgent", code: { agent: "claude", unset: ["SECRET"] } }),
        stdout,
        modelResolver,
        quotaReader,
      }),
    ).toBe(0);
    expect(stdout.text()).toContain(
      "Profile: test; native source: claude\n" +
        "Limits belong to this native CLI's account; account pairing with the coding agent is not verified.\n" +
        "Claude Code quota\n\nCurrent session: 25% used\n",
    );
    expect(quotaReader).toHaveBeenCalledWith("claude", {
      cwd: tmpdir(),
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
        home: makeHome({ platform: "codingAgent", code: { agent: "codex" } }),
        stderr,
        quotaReader,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain(
      'Quota source codex, profile "test", selected native configuration: limits unavailable',
    );
    expect(stderr.text()).toContain("installed and authenticated under this quota configuration");
  });
});

describe("resolveTicket", () => {
  function record(overrides: Partial<SessionFrontmatter>): SessionRecord {
    return {
      path: "/proj/.plans/30/_aligndev/r.md",
      frontmatter: {
        status: "succeeded",
        agent: "claude",
        profile: null,
        protocol: "spec",
        ticket: "30",
        model: null,
        sessionId: "abc",
        command: "aligndev code new --protocol spec --ticket 30 --message go",
        meta: null,
        pid: null,
        pidStartTime: null,
        machineId: "test-machine",
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

  it("resume inherits the latest run's ticket, including null", () => {
    const records = [
      record({ ticket: "30", startedAt: "2026-07-01T09:00:00.000Z" }),
      record({ ticket: "31", startedAt: "2026-07-01T10:00:00.000Z" }),
      record({ ticket: null, startedAt: "2026-07-01T11:00:00.000Z" }),
      record({ ticket: "99", sessionId: "other", startedAt: "2026-07-01T12:00:00.000Z" }),
    ];
    expect(resolveTicket(parse(["resume", "abc", "--message", "m"]), records)).toBeUndefined();
  });

  it("resume without any ticketed record yields no ticket", () => {
    const records = [record({ ticket: null })];
    expect(resolveTicket(parse(["resume", "abc", "--message", "m"]), records)).toBeUndefined();
  });

  it("infers the ticket from a .plans/<ticket>/ path in the message", () => {
    const parsed = parse(["new", "--message", "Execute the plan: .plans/2/B2-plan.md"]);
    expect(resolveTicket(parsed, [])).toBe("2");
  });

  it("ignores _-prefixed segments such as _aligndev", () => {
    const parsed = parse(["new", "--message", "See .plans/_aligndev/20260706-122913.md"]);
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
  const CODE: CodeConfig = {
    agent: "claude",
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
      alignfirst: "alignfirst",
      ...overrides,
    });
  }

  it("threads the caller env into the config so the child inherits the same source", () => {
    const env = { FOO: "bar" };
    const config = build({
      code: { ...CODE, skipPermissions: true, unset: ["X", "Y"], childEnv: env },
    });
    expect(config.env).toBe(env);
    expect(config.executableModel).toBeUndefined();
    expect(config.skipPermissions).toBe(true);
    expect(config.resume).toBeUndefined();
  });

  it("carries quiet to the runner without changing the prompt", () => {
    const ordinary = build({});
    const quiet = build({ args: parse(["new", "-m", "go", "--quiet"]) });
    expect(ordinary.quiet).toBeUndefined();
    expect(quiet).toEqual({ ...ordinary, quiet: true });
  });

  it("puts the effective ticket, not the flag, in the prompt", () => {
    const config = build({ args: parse(["resume", "abc", "--protocol", "plan"]), ticket: "30" });
    expect(config.prompt).toBe(
      "Run `alignfirst guide plan` and follow the protocol. Ticket ID = 30.",
    );
    expect(config.resume).toBe("abc");
    expect(config.skipPermissions).toBe(false);
  });

  it("adds the companion as a writable directory, whatever it holds", () => {
    for (const items of [[], ["_aligndev"], [".plans"]] satisfies ItemName[][]) {
      const report = reportWithCompanion(items);
      expect(build({ report }).additionalDirectories).toEqual(["/companions/proj"]);
    }
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
    cli: null,
    config: null,
    companion: { dir: "/companions/proj", exists: true },
    aligndev: null,
    locations: {
      ".alignfirst.json": location(".alignfirst.json", ".alignfirst.json"),
      ".alignfirst-instructions": location(".alignfirst-instructions", ".alignfirst-instructions"),
      "DEVELOPERS.md": location("DEVELOPERS.md", "DEVELOPERS.md"),
      docs: location("docs", "docs"),
      ".plans": location(".plans", ".plans"),
      _aligndev: location(".plans", "_aligndev"),
    },
  };
}

describe("launch guards", () => {
  let dir: string;
  let plans: string;
  let home: string;
  let realCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aligndev-guards-"));
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
      profile: null,
      protocol: "spec",
      ticket: "30",
      model: null,
      sessionId: null,
      command: "aligndev code new --protocol spec --ticket 30 --message go",
      meta: null,
      pid: process.pid,
      pidStartTime: null,
      machineId: readMachineId(home),
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
    writeInitialSessionFile(
      join(dir, ".plans", "30", "_aligndev", name),
      makeFrontmatter(overrides),
    );
  }

  async function run(tokens: string[]): Promise<{ code: number; stderr: string }> {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", ...tokens],
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
    expect(stderr).toContain(
      `session abc is still running (${join(plans, "30", "_aligndev", "running.md")}, pid ${process.pid})`,
    );
    expect(stderr).toContain("wait for it to finish");
    expect(stderr).not.toContain("kill it");
  });

  it.each(["another-machine", null])(
    "keeps dead records owned by %j blocking resumes and protocol launches",
    async (machineId) => {
      const child = spawnSync("node", ["-e", ""]);
      if (child.pid === undefined) throw new Error("failed to spawn a probe child");
      seedRecord("foreign.md", { sessionId: "abc", pid: child.pid, machineId });
      const path = join(plans, "30", "_aligndev", "foreign.md");
      const before = readFileSync(path, "utf8");
      for (const tokens of [
        ["resume", "abc", "--message", "hi"],
        ["new", "--protocol", "plan", "--ticket", "31"],
      ]) {
        const { code, stderr } = await run(tokens);
        expect(code).toBe(1);
        expect(stderr).toContain(path);
        expect(stderr).toContain(
          "this record was written by another machine or before machine identities",
        );
        expect(stderr).toContain(
          "check it on its machine, or set its `status` by hand once the run has ended",
        );
        expect(stderr).not.toContain("kill it");
      }
      expect(readFileSync(path, "utf8")).toBe(before);
      const records = listSessionRecords(plans, readMachineId(home));
      expect(records).toHaveLength(1);
      const otherWorktree = records.map((record) => ({
        ...record,
        frontmatter: { ...record.frontmatter, cwd: "/elsewhere" },
      }));
      const error = checkLaunchGuards(
        parse(["new", "--protocol", "plan", "--ticket", "30"]),
        "claude",
        realCwd,
        "30",
        otherWorktree,
        readMachineId(home),
      );
      expect(error).toContain("already active on ticket 30");
      expect(error).toContain(path);
      expect(error).toContain("set its `status` by hand once the run has ended");
    },
  );

  it("rejects legacy and cross-agent resumes", () => {
    const parsed = parse(["resume", "abc", "--message", "continue"]);
    const legacy = [
      {
        path: "legacy.md",
        frontmatter: makeFrontmatter({ status: "succeeded", sessionId: "abc", agent: null }),
      },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, undefined, legacy, readMachineId(home)),
    ).toContain("predates agent-aware sessions");

    const codex = [
      {
        path: "codex.md",
        frontmatter: makeFrontmatter({ status: "succeeded", sessionId: "abc", agent: "codex" }),
      },
    ];
    const mismatch = checkLaunchGuards(
      parsed,
      "claude",
      realCwd,
      undefined,
      codex,
      readMachineId(home),
    );
    expect(mismatch).toContain("belongs to agent codex");
    expect(mismatch).toContain("selected agent is claude");
  });

  it("rejects a cross-agent resume before discovery or session creation", async () => {
    seedRecord("codex.md", { status: "succeeded", sessionId: "abc", agent: "codex" });
    const before = listSessionRecords(plans, readMachineId(home)).length;
    const modelResolver = vi.fn(async () => "gpt-5.6-terra");
    const stderr = makeSink();
    const otherHome = makeHome({
      platform: "codingAgent",
      code: { agent: "claude", models: ["terra"] },
    });
    const code = await main({
      argv: ["node", "aligndev", "code", "resume", "abc", "--message", "go", "--model", "terra"],
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
    expect(listSessionRecords(plans, readMachineId(home))).toHaveLength(before);
  });

  it("sanitizes injected model-discovery failures on every output surface", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const codexHome = makeHome({ platform: "codingAgent", code: { agent: "codex" } });
    const code = await main({
      argv: ["node", "aligndev", "code", "new", "--message", "go", "--model", "terra"],
      cwd: dir,
      env: { HOME: codexHome },
      home: codexHome,
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
      modelResolver: async () => {
        throw new Error("catalog unavailable: injected-resolver-secret");
      },
    });

    expect(code).toBe(1);
    expect(stdout.text()).toContain("Session file:");
    expect(stderr.text()).toContain("Could not resolve the codex model");
    expect(stdout.text() + stderr.text()).not.toContain("injected-resolver-secret");
    const records = listSessionRecords(plans, readMachineId(codexHome));
    expect(records).toHaveLength(1);
    expect(readCompletion(records[0].path)).toMatchObject({
      frontmatter: { status: "failed", exitReason: "error", sessionId: null },
      result: expect.stringContaining("Could not resolve the codex model"),
    });
    expect(readFileSync(records[0].path, "utf8")).not.toContain("injected-resolver-secret");
  });

  it("reserves the next side ticket through alignfirst for --no-ticket", async () => {
    mkdirSync(join(dir, ".plans", "side-1"));
    const stdout = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
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
    expect(stdout.text()).toContain(`Session file: ${join(".plans", "side-2", "_aligndev")}`);
    const [record] = listSessionRecords(plans, readMachineId(home));
    expect(record.frontmatter.machineId).toBe(readMachineId(home));
    expect(record.frontmatter.ticket).toBe("side-2");
    expect(record.frontmatter.command).toBe(
      'aligndev code new --protocol aad --no-ticket --message "go"',
    );
  });

  it("reports a missing alignfirst executable before writing a session file", async () => {
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", "new", "--protocol", "aad", "--no-ticket", "-m", "go"],
      cwd: dir,
      env: { HOME: home },
      home,
      stderr,
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain("alignfirst is not installed");
    expect(stderr.text()).toContain("executable /nonexistent/alignfirst (not found)");
    expect(listSessionRecords(plans, readMachineId(home))).toEqual([]);
  });

  it("rejects a protocol run while another run is active in the same worktree", async () => {
    seedRecord("running.md", { sessionId: "abc" });
    const { code, stderr } = await run(["new", "--protocol", "plan", "--ticket", "31"]);
    expect(code).toBe(1);
    expect(stderr).toContain("a spec protocol run is already active in this worktree");
    expect(stderr).toContain(`pid ${process.pid}`);
    expect(stderr).toContain(join(plans, "30", "_aligndev", "running.md"));
    expect(stderr).toContain("wait for it to finish");
    expect(stderr).not.toContain("kill it");
  });

  it("allows a protocol run when the active run sits in another worktree", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "31"]);
    const records = [
      {
        path: "/elsewhere/.plans/30/_aligndev/r.md",
        frontmatter: makeFrontmatter({ sessionId: "abc", cwd: "/elsewhere" }),
      },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, "31", records, readMachineId(home)),
    ).toBeUndefined();
  });

  it("lets a protocol run start while a plain run is active in the same worktree", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "31"]);
    const records = [
      { path: "r.md", frontmatter: makeFrontmatter({ sessionId: "abc", protocol: null }) },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, "31", records, readMachineId(home)),
    ).toBeUndefined();
  });

  it("rejects a protocol run on a ticket with an active protocol run in another worktree", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "31"]);
    const records = [
      {
        path: "/elsewhere/.plans/31/_aligndev/r.md",
        frontmatter: makeFrontmatter({ sessionId: "abc", cwd: "/elsewhere", ticket: "31" }),
      },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, "31", records, readMachineId(home)),
    ).toContain("a spec protocol run is already active on ticket 31");
  });

  it("rejects a protocol run on another ticket while a protocol run holds the worktree", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "31"]);
    const records = [{ path: "r.md", frontmatter: makeFrontmatter({ sessionId: "abc" }) }];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, "31", records, readMachineId(home)),
    ).toContain("a spec protocol run is already active in this worktree");
  });

  it("lets a protocol run start while a resume without protocol runs on its ticket", () => {
    const parsed = parse(["new", "--protocol", "plan", "--ticket", "30"]);
    const records = [
      { path: "r.md", frontmatter: makeFrontmatter({ sessionId: "abc", protocol: null }) },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, "30", records, readMachineId(home)),
    ).toBeUndefined();
  });

  it("checks only the worktree for a --no-ticket protocol run", () => {
    const parsed = parse(["new", "--protocol", "aad", "--no-ticket", "--message", "go"]);
    const records = [
      {
        path: "/elsewhere/.plans/30/_aligndev/r.md",
        frontmatter: makeFrontmatter({ sessionId: "abc", cwd: "/elsewhere" }),
      },
    ];
    expect(
      checkLaunchGuards(parsed, "claude", realCwd, undefined, records, readMachineId(home)),
    ).toBeUndefined();
  });

  it("exempts no-protocol invocations from the busy-worktree guard", () => {
    const records = [
      {
        path: join(dir, ".plans", "30", "_aligndev", "r.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc" }),
      },
      // A resumable (finished) record so only the busy-worktree guard is in play.
      {
        path: join(dir, ".plans", "30", "_aligndev", "done.md"),
        frontmatter: makeFrontmatter({ sessionId: "abc2", status: "succeeded" }),
      },
    ];
    const answer = parse(["resume", "abc2", "--message", "answer"]);
    expect(
      checkLaunchGuards(answer, "claude", realCwd, undefined, records, readMachineId(home)),
    ).toBeUndefined();

    const execute = parse(["new", "--message", "Execute the plan"]);
    expect(
      checkLaunchGuards(execute, "claude", realCwd, undefined, records, readMachineId(home)),
    ).toBeUndefined();
  });
});

describe("model selection", () => {
  let base: string;
  let home: string;
  let project: string;
  let plans: string;
  let fake: FakeClaude;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aligndev-model-"));
    home = join(base, "home");
    project = join(base, "project");
    plans = join(project, ".plans");
    mkdirSync(plans, { recursive: true });
    writeConfig(home, {
      platform: "codingAgent",
      code: { agent: "claude", defaultModel: "sonnet" },
    });
    fake = installFakeClaude(base);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // Runs `aligndev code` and returns the `--model` value the agent received, if any.
  async function launch(tokens: string[]): Promise<string | undefined> {
    const code = await main({
      argv: ["node", "aligndev", "code", ...tokens],
      cwd: project,
      env: { PATH: fake.path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout: makeSink(),
      stderr: makeSink(),
      modelResolver: async (_agent, model) => model,
    });
    expect(code).toBe(0);
    const { args } = fake.received();
    const index = args.indexOf("--model");
    return index === -1 ? undefined : args[index + 1];
  }

  function newestFrontmatter(): SessionFrontmatter {
    const records = listSessionRecords(plans, readMachineId(home));
    return records.reduce((a, b) => (a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b))
      .frontmatter;
  }

  it("starts a new session with the profile defaultModel and records it", async () => {
    expect(await launch(["new", "-m", "go"])).toBe("sonnet");
    expect(newestFrontmatter()).toMatchObject({
      model: "sonnet",
      command: 'aligndev code new --message "go"',
    });
  });

  it("lets --model override the profile defaultModel", async () => {
    expect(await launch(["new", "-m", "go", "--model", "haiku"])).toBe("haiku");
    expect(newestFrontmatter().model).toBe("haiku");
  });

  it("resumes with the model of the session's latest run, not the profile defaultModel", async () => {
    writeInitialSessionFile(
      join(plans, "_aligndev", "old.md"),
      statusFrontmatter({ sessionId: "abc", model: "opus", startedAt: "2026-08-29T10:00:00.000Z" }),
    );
    writeInitialSessionFile(
      join(plans, "_aligndev", "latest.md"),
      statusFrontmatter({ sessionId: "abc", model: "haiku" }),
    );
    expect(await launch(["resume", "abc", "-m", "more"])).toBe("haiku");
    expect(newestFrontmatter().model).toBe("haiku");
  });

  it("resumes without a model flag when the latest run recorded none", async () => {
    writeInitialSessionFile(
      join(plans, "_aligndev", "latest.md"),
      statusFrontmatter({ sessionId: "abc", model: null }),
    );
    expect(await launch(["resume", "abc", "-m", "more"])).toBeUndefined();
    expect(newestFrontmatter().model).toBeNull();
  });
});

describe("companion projects", () => {
  let base: string;
  let home: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aligndev-companion-"));
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
      argv: ["node", "aligndev", "code", ...tokens],
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
    const project = makeCompanionProject(home, { ".plans": "companion" });
    const plans = join(project.companion, ".plans");

    const gated = await run(project, ["new", "-m", "go"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toBe(
      `No .plans/ directory at ${plans} (companion).\n` +
        `Local work files:  mkdir -p ${plans}\n` +
        "Team work files:   alignfirst plans setup <clone-dir>\n" +
        "See the `work-files-setup` topic of `aligndev guide` for authorized preparation.\n",
    );

    mkdirSync(plans, { recursive: true });
    const started = await run(project, ["new", "-m", "go"]);
    expect(started.stderr).toContain("Could not resolve the claude model");
    expect(started.stdout).toContain(`Session file: ${join(plans, "_aligndev")}/`);
    expect(listSessionRecords(plans, readMachineId(home))).toHaveLength(1);
  });

  it("writes a separate _aligndev tree and opens the ticket in both trees", async () => {
    const project = makeCompanionProject(home, { ".plans": "project", _aligndev: "companion" });
    const plans = join(project.project, ".plans");
    const sessions = join(project.companion, ".plans");
    mkdirSync(join(plans, "_archives", "29"), { recursive: true });
    mkdirSync(join(sessions, "_archives", "29", "_aligndev"), { recursive: true });

    const started = await run(project, ["new", "--ticket", "29", "-m", "go"]);
    expect(started.stdout).toContain(`Session file: ${join(sessions, "29", "_aligndev")}/`);
    expect(existsSync(join(plans, "29"))).toBe(true);
    expect(existsSync(join(sessions, "_archives", "29"))).toBe(false);
    expect(existsSync(join(plans, "29", "_aligndev"))).toBe(false);
    expect(listSessionRecords(sessions, readMachineId(home))).toHaveLength(1);

    rmSync(join(plans, "29"), { recursive: true });
    expect(listSessionRecords(sessions, readMachineId(home))).toHaveLength(1);
  });

  it("reserves a side ticket in the companion .plans", async () => {
    const project = makeCompanionProject(home, { ".plans": "companion" });
    const plans = join(project.companion, ".plans");
    mkdirSync(join(plans, "side-1"), { recursive: true });

    const started = await run(project, ["new", "--protocol", "aad", "--no-ticket", "-m", "go"]);
    expect(started.stdout).toContain(`Session file: ${join(plans, "side-2", "_aligndev")}/`);
  });

  describe("status", () => {
    let project: CompanionProject;
    let ticketFile: string;
    let noTicketFile: string;
    beforeEach(() => {
      project = makeCompanionProject(home, { ".plans": "project", _aligndev: "companion" });
      mkdirSync(join(project.project, ".plans", "29"), { recursive: true });
      const sessions = join(project.companion, ".plans");
      ticketFile = join(sessions, "29", "_aligndev", "20260829-115529.md");
      noTicketFile = join(sessions, "_aligndev", "20260829-115530.md");
      writeInitialSessionFile(ticketFile, statusFrontmatter({ ticket: "29", meta: "thread-1" }));
      writeInitialSessionFile(noTicketFile, statusFrontmatter({ ticket: null }));
      for (const file of [ticketFile, noTicketFile]) {
        appendTranscript(file, "internal companion transcript\n");
        applyCompletion(file, {
          status: "succeeded",
          exitReason: "completed",
          endedAt: "2026-08-29T11:56:29Z",
          sessionId: "sess-42",
          result: "companion answer",
        });
      }
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
        for (const includeResult of [false, true]) {
          const result = await run(project, [...tokens, ...(includeResult ? ["--result"] : [])]);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(`sessionFile: ${expected}\n`);
          expect(result.stdout.includes(`${RESULT_MARKER}\ncompanion answer\n`)).toBe(
            includeResult,
          );
          expect(result.stdout).not.toContain("internal companion transcript");
        }
      }
    });

    it("rejects a session file outside the sessions directory", async () => {
      const projectFile = join(project.project, ".plans", "29", "_aligndev", "20260829-115529.md");
      writeInitialSessionFile(projectFile, statusFrontmatter({ ticket: "29" }));
      const sessions = join(project.companion, ".plans");

      const result = await run(project, ["status", ".plans/29/_aligndev/20260829-115529.md"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `Error: status requires a session file under ${sessions}/_aligndev/ or ` +
          `${sessions}/<ticket>/_aligndev/.\n`,
      );
    });
  });

  it("status does not create a missing companion", async () => {
    const project = makeCompanionProject(home, { ".plans": "project", _aligndev: "companion" });
    mkdirSync(join(project.project, ".plans"));
    const result = await run(project, ["status", "--meta", "missing", "--result"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no session file");
    expect(existsSync(project.companion)).toBe(false);
  });

  it("keeps distinct meta results in a shared companion across worktrees", async () => {
    const project = makeCompanionProject(home, { ".plans": "project", _aligndev: "companion" });
    const worktree = join(home, "other-worktree");
    spawnSync("git", [
      "-C",
      project.project,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    const added = spawnSync("git", [
      "-C",
      project.project,
      "worktree",
      "add",
      "-b",
      "other",
      worktree,
    ]);
    expect(added.status).toBe(0);
    const sessions = join(project.companion, ".plans");
    for (const [index, meta] of ["run-first", "run-second"].entries()) {
      const file = join(sessions, "_aligndev", `20260829-11553${index}.md`);
      writeInitialSessionFile(
        file,
        statusFrontmatter({
          meta,
          cwd: index === 0 ? project.project : worktree,
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
    for (const cwd of [project.project, worktree]) {
      for (const meta of ["run-first", "run-second"]) {
        const result = await run({ ...project, project: cwd }, [
          "status",
          "--meta",
          meta,
          "--result",
        ]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`${RESULT_MARKER}\nanswer ${meta}\n`);
        expect(result.stdout).not.toContain(
          `answer ${meta === "run-first" ? "run-second" : "run-first"}`,
        );
      }
    }
  });

  it("adds the companion directory and the project context for the agent", async () => {
    const project = makeCompanionProject(home, { ".plans": "companion" });
    mkdirSync(join(project.companion, ".plans"), { recursive: true });
    const { path, received } = installFakeClaude(base);

    const stdout = makeSink();
    const started = await main({
      argv: ["node", "aligndev", "code", "new", "-m", "go"],
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
    expect(first.prompt).toMatch(
      /^## Run context\n\n.+\n\n## Project context\n\n# Project Conventions\n/,
    );
    expect(first.prompt).toMatch(/\n\n## Current instruction\n\ngo$/);
    expect(first.args).toEqual(expect.arrayContaining(["--add-dir", project.companion]));

    const resumed = await main({
      argv: ["node", "aligndev", "code", "resume", "session-1", "-m", "more"],
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

  it("adds the companion without the project context when it holds only sessions", async () => {
    const project = makeCompanionProject(home, { ".plans": "project", _aligndev: "companion" });
    mkdirSync(join(project.project, ".plans"), { recursive: true });
    mkdirSync(join(project.companion, ".plans"), { recursive: true });
    const { path, received } = installFakeClaude(base);

    const started = await main({
      argv: ["node", "aligndev", "code", "new", "-m", "go"],
      cwd: project.project,
      env: { PATH: path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout: makeSink(),
      stderr: makeSink(),
      modelResolver: async () => undefined,
    });
    expect(started).toBe(0);
    const { prompt, args } = received();
    expect(prompt).not.toContain("## Project context");
    expect(prompt).toMatch(/\n\n## Current instruction\n\ngo$/);
    expect(args).toEqual(expect.arrayContaining(["--add-dir", project.companion]));
  });

  it("creates a missing companion directory before adding it", async () => {
    const project = makeCompanionProject(home, { ".plans": "project" });
    mkdirSync(join(project.project, ".plans"), { recursive: true });
    const { path, received } = installFakeClaude(base);

    const started = await main({
      argv: ["node", "aligndev", "code", "new", "-m", "go"],
      cwd: project.project,
      env: { PATH: path, HOME: home },
      home,
      alignfirstCommand: ALIGNFIRST,
      stdout: makeSink(),
      stderr: makeSink(),
      modelResolver: async () => undefined,
    });
    expect(started).toBe(0);
    expect(existsSync(project.companion)).toBe(true);
    expect(received().args).toEqual(expect.arrayContaining(["--add-dir", project.companion]));
  });
});

describe("quiet execution", () => {
  let base: string;
  let home: string;
  let project: string;
  let plans: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aligndev-quiet-"));
    home = join(base, "home");
    project = join(base, "project");
    plans = join(project, ".plans");
    mkdirSync(plans, { recursive: true });
    writeConfig(home, { code: { agent: "claude" } });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function launch(tokens: string[], path: string) {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", ...tokens],
      cwd: project,
      home,
      env: { HOME: home, PATH: path },
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
      modelResolver: async (_agent, model) => model,
    });
    const records = listSessionRecords(plans, readMachineId(home));
    const latest = records.reduce((a, b) =>
      a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b,
    );
    return {
      code,
      stdout: stdout.text(),
      stderr: stderr.text(),
      file: latest.path,
      completion: readCompletion(latest.path),
    };
  }

  it("retains control lines on quiet new/resume and records the flag", async () => {
    const fake = installFakeClaude(
      base,
      `
      process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "private transcript" }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", result: "final answer" }));
    `,
    );
    const started = await launch(["new", "-m", "go", "--quiet"], fake.path);
    expect(started.code).toBe(0);
    expect(started.stdout).toBe(
      `Session file: ${relative(project, started.file).replace(/\.md$/, ".running.md")}\n\n\nSession ID: session-1\n`,
    );
    expect(started.stderr).toBe("");
    expect(started.completion.result).toBe("final answer");
    expect(started.completion.frontmatter.command).toContain("--quiet");
    expect(readFileSync(started.file, "utf8")).toContain("private transcript");
    const resumed = await launch(["resume", "session-1", "-m", "more", "--quiet"], fake.path);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toBe(
      `Session file: ${relative(project, resumed.file).replace(/\.md$/, ".running.md")}\n\n`,
    );
    expect(resumed.completion.frontmatter.command).toContain("--quiet");
  });

  it.each([
    [
      "stderr",
      'process.stderr.write("service unavailable: credential-must-stay-private".repeat(200)); process.exitCode = 7;',
    ],
    [
      "incomplete",
      'process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "internal-only" }] } }));',
    ],
  ])("keeps %s failures durable with bounded quiet diagnostics", async (_name, response) => {
    const fake = installFakeClaude(base, response);
    const result = await launch(["new", "-m", "go", "--quiet"], fake.path);
    expect(result.code).toBe(1);
    expect(result.completion.frontmatter).toMatchObject({ status: "failed", exitReason: "error" });
    expect(result.stderr).toContain("claude run failed; inspect the session file");
    expect(result.stderr).toContain(`Session file: ${relative(project, result.file)}\n`);
    expect(result.stderr).not.toContain("credential-must-stay-private");
    expect(result.stdout).not.toContain("internal-only");
    expect(result.stdout.length + result.stderr.length).toBeLessThan(700);
  });

  it("reports a missing executable and preserves the durable failure", async () => {
    installGit(base);
    const result = await launch(["new", "-m", "go", "--quiet"], base);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("claude could not start; check its installation and PATH");
    expect(result.stderr).toContain("Session file:");
    expect(result.completion.frontmatter.status).toBe("failed");
    expect(result.completion.result).toContain("ENOENT");
  });

  it("reports a prompt-pipe failure without dumping the prompt", async () => {
    const fake = installFakeClaude(base);
    writeFileSync(
      join(base, "bin", "claude"),
      `#!${process.execPath}\nrequire("node:fs").closeSync(0); setTimeout(() => {}, 10000);\n`,
    );
    const result = await launch(["new", "-m", "x".repeat(2_000_000), "--quiet"], fake.path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not send the prompt to claude");
    expect(result.stderr).toContain("Session file:");
    expect(result.completion.result).toContain("Could not send prompt:");
    expect(result.stdout.length + result.stderr.length).toBeLessThan(700);
  });

  it.each([false, true])(
    "keeps authentication exit 2 and one diagnostic with quiet=%s",
    async (quiet) => {
      const fake = installFakeClaude(
        base,
        `
      process.stdout.write(JSON.stringify({ type: "assistant", error: "authentication_failed" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "credential-must-stay-private".repeat(200) }));
    `,
      );
      const result = await launch(["new", "-m", "go", ...(quiet ? ["--quiet"] : [])], fake.path);
      expect(result.code).toBe(2);
      expect(result.completion.frontmatter).toMatchObject({
        status: "failed",
        exitReason: "auth_required",
      });
      expect(result.stderr.match(/not authenticated/g)).toHaveLength(1);
      expect(result.stderr).toContain("/login");
      expect(result.stderr).toContain("Session file:");
      expect(result.stderr).not.toContain("credential-must-stay-private");
      expect(result.stdout.length + result.stderr.length).toBeLessThan(700);
    },
  );

  it("sanitizes quiet model-resolution failures in diagnostics and the file", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const detail = "catalog unavailable: credential-must-stay-private".repeat(200);
    const code = await main({
      argv: ["node", "aligndev", "code", "new", "-m", "go", "--quiet"],
      cwd: project,
      home,
      env: { HOME: home },
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
      modelResolver: async () => {
        throw new Error(detail);
      },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Could not resolve the claude model; check --model");
    expect(stderr.text()).toContain("Session file:");
    expect(stderr.text()).not.toContain(detail);
    expect(stderr.text().length).toBeLessThan(500);
    const [record] = listSessionRecords(plans, readMachineId(home));
    expect(readCompletion(record.path)).toMatchObject({
      frontmatter: { status: "failed" },
      result: expect.stringContaining("Could not resolve the claude model"),
    });
    expect(readFileSync(record.path, "utf8")).not.toContain("credential-must-stay-private");
  });
});

describe("pi launches", () => {
  let base: string;
  let home: string;
  let project: string;
  let plans: string;
  let fake: FakeClaude;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aligndev-pi-"));
    tempDirs.push(base);
    home = join(base, "home");
    project = join(base, "project");
    plans = join(project, ".plans");
    mkdirSync(plans, { recursive: true });
    writeConfig(home, { code: { agent: "pi" } });
    fake = installFakePi(base);
  });

  async function launch(tokens: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = project) {
    const stdout = makeSink();
    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aligndev", "code", ...tokens],
      cwd,
      home,
      env: { HOME: home, PATH: fake.path, ...extraEnv },
      alignfirstCommand: ALIGNFIRST,
      stdout,
      stderr,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  function newest() {
    return listSessionRecords(plans, readMachineId(home)).reduce((a, b) =>
      a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b,
    );
  }

  it("starts quietly with native selectors and resumes the exact session with inherited models", async () => {
    const selected = "provider/model:high";
    const first = await launch(["new", "-m", "go", "--model", selected, "--quiet"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("Session file:");
    expect(first.stdout).toContain("Session ID: pi-session");
    expect(first.stdout).not.toContain("private pi answer");
    expect(fake.received().args).toEqual(["--mode", "json", "--model", selected]);
    expect(fake.received().prompt).toMatch(/go$/);
    const initial = newest();
    expect(readCompletion(initial.path)).toMatchObject({
      frontmatter: { agent: "pi", model: selected },
      result: "private pi answer",
    });
    writeConfig(home, {
      code: { agent: "pi", models: [selected, "other/model"], defaultModel: "other/model" },
    });
    const resumed = await launch(["resume", "pi-session", "-m", "more", "--quiet"]);
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

  it.each([undefined, "terra", " provider/model:high "])(
    "preserves native model selection %j",
    async (model) => {
      const result = await launch([
        "new",
        "-m",
        "go",
        ...(model === undefined ? [] : ["--model", model]),
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(fake.received().args).toEqual([
        "--mode",
        "json",
        ...(model === undefined ? [] : ["--model", model]),
      ]);
    },
  );

  it("validates blank selectors and exact configured allowlists before creating runs", async () => {
    for (const model of ["", " \t "]) {
      const result = await launch(["new", "-m", "go", "--model", model]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("nonblank");
    }
    writeConfig(home, { code: { agent: "pi", models: ["provider/model"] } });
    expect((await launch(["new", "-m", "go", "--model", "terra"])).stderr).toContain(
      "one of: provider/model",
    );
    expect(listSessionRecords(plans, readMachineId(home))).toHaveLength(0);
  });

  it("rejects another real worktree before writing a run or invoking pi", async () => {
    const other = join(base, "other-worktree");
    mkdirSync(other);
    writeInitialSessionFile(
      join(plans, "_aligndev", "original.md"),
      statusFrontmatter({ agent: "pi", sessionId: "pi-session", cwd: other }),
    );
    const result = await launch(["resume", "pi-session", "-m", "more"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`must resume from its recorded directory ${other}`);
    expect(result.stdout).not.toContain("Session file:");
    expect(listSessionRecords(plans, readMachineId(home))).toHaveLength(1);
    expect(existsSync(join(base, "bin", "pi-args.json"))).toBe(false);
  });

  it("uses the latest recorded cwd, permits symlink aliases and retains same-agent guards", () => {
    const alias = join(base, "alias");
    symlinkSync(project, alias);
    const old = {
      path: "old",
      frontmatter: statusFrontmatter({
        agent: "pi",
        sessionId: "pi-session",
        cwd: base,
        startedAt: "2020-01-01",
      }),
    };
    const latest = {
      path: "latest",
      frontmatter: statusFrontmatter({ agent: "pi", sessionId: "pi-session", cwd: alias }),
    };
    const args = parse(["resume", "pi-session", "-m", "go"]);
    expect(
      checkLaunchGuards(
        args,
        "pi",
        realpathSync(project),
        undefined,
        [old, latest],
        readMachineId(home),
      ),
    ).toBeUndefined();
    expect(
      checkLaunchGuards(
        args,
        "claude",
        realpathSync(project),
        undefined,
        [latest],
        readMachineId(home),
      ),
    ).toContain("belongs to agent pi");
    expect(
      checkLaunchGuards(
        args,
        "pi",
        realpathSync(project),
        undefined,
        [{ ...latest, frontmatter: { ...latest.frontmatter, agent: "codex" } }],
        readMachineId(home),
      ),
    ).toContain("selected agent is pi");
  });

  it("retains the requested identity while failing a mismatched resumed header", async () => {
    expect((await launch(["new", "-m", "go"])).code).toBe(0);
    const result = await launch(["resume", "pi-session", "-m", "more", "--quiet"], {
      PI_FIXTURE_ID: "forked-session",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pi run failed");
    expect(readCompletion(newest().path)).toMatchObject({
      frontmatter: { status: "failed", sessionId: "pi-session", exitReason: "error" },
      result: expect.stringContaining("differs from pi-session"),
    });
  });

  it.each(["protocol", "startup"])(
    "keeps %s authentication exit 2 and pi login guidance",
    async (channel) => {
      const result = await launch(["new", "-m", "go", "--quiet"], { PI_FIXTURE_AUTH: channel });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("/login <provider>");
      expect(result.stderr).not.toContain("codex login");
      expect(readCompletion(newest().path).frontmatter.exitReason).toBe("auth_required");
    },
  );

  it("reports a missing pi executable with installation guidance", async () => {
    installGit(base);
    const result = await launch(["new", "-m", "go", "--quiet"], { PATH: base });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pi could not start; check its installation and PATH");
    expect(readCompletion(newest().path).result).toContain("ENOENT");
  });

  it("fails a zero-exit incomplete stream with bounded quiet diagnostics", async () => {
    const result = await launch(["new", "-m", "go", "--quiet"], { PI_FIXTURE_INCOMPLETE: "true" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pi run failed");
    expect(result.stdout).not.toContain("private pi answer");
    expect(readCompletion(newest().path).result).toContain("before agent_settled");
  });

  it("prepares a missing companion independently of permission flags, only on launch", async () => {
    mkdirSync(home, { recursive: true });
    const companion = makeCompanionProject(home, { ".plans": "project" });
    mkdirSync(join(companion.project, ".plans"));
    project = companion.project;
    plans = join(project, ".plans");
    expect((await launch(["status", "--no-ticket"])).code).toBe(1);
    expect(existsSync(companion.companion)).toBe(false);
    const result = await launch(["new", "-m", "go"]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(companion.companion)).toBe(true);
    expect(fake.received().args).toEqual(["--mode", "json"]);
  });

  it("reports unsupported quota and unrestricted help without launching pi", async () => {
    const quota = await launch(["quota"]);
    expect(quota.code).toBe(1);
    expect(quota.stderr).toContain("Pi account quota is unsupported");
    const help = await launch(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Any nonblank pi-native selector");
    expect(help.stdout).toContain("Ordinary OS permissions");
    expect(existsSync(join(base, "bin", "pi-args.json"))).toBe(false);
  });
});

function installFakePi(base: string): FakeClaude {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "pi"),
    `#!${process.execPath}
const { writeFileSync } = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(join(bin, "pi-prompt.txt"))}, prompt);
  writeFileSync(${JSON.stringify(join(bin, "pi-args.json"))}, JSON.stringify(process.argv.slice(2)));
  if (process.env.PI_FIXTURE_AUTH === "startup") {
    process.stderr.write("No API key found for example.");
    process.exitCode = 1;
    return;
  }
  const auth = process.env.PI_FIXTURE_AUTH === "protocol";
  const events = [
    { type: "session", version: 3, id: process.env.PI_FIXTURE_ID ?? "pi-session", cwd: process.cwd(), timestamp: new Date().toISOString() },
    { type: "message_end", message: { role: "assistant", stopReason: auth ? "error" : "stop", errorMessage: auth ? "No API key found for example." : undefined, content: [{ type: "text", text: "private pi answer" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    ...(process.env.PI_FIXTURE_INCOMPLETE === "true" ? [] : [{ type: "agent_settled", aborted: false }]),
  ];
  process.stdout.write(events.map(JSON.stringify).join("\\n"));
});
`,
    { mode: 0o755 },
  );
  return {
    path: `${bin}:${process.env.PATH ?? ""}`,
    received: () => ({
      prompt: readFileSync(join(bin, "pi-prompt.txt"), "utf8"),
      args: JSON.parse(readFileSync(join(bin, "pi-args.json"), "utf8")),
    }),
  };
}

interface FakeClaude {
  path: string;
  received: () => { prompt: string; args: string[] };
}

// A `claude` on PATH that records its prompt and arguments, then reports session `session-1`.
function installFakeClaude(
  base: string,
  response = 'process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "session-1" }));',
): FakeClaude {
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
  ${response}
});
`,
    { mode: 0o755 },
  );
  const path = `${bin}:${process.env.PATH ?? ""}`;
  const received = () => ({
    prompt: readFileSync(join(bin, "prompt.txt"), "utf8"),
    args: JSON.parse(readFileSync(join(bin, "args.json"), "utf8")),
  });
  return { path, received };
}

function statusFrontmatter(overrides: Partial<SessionFrontmatter>): SessionFrontmatter {
  return {
    status: "succeeded",
    agent: "claude",
    profile: null,
    protocol: "review",
    ticket: null,
    model: null,
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
