import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgyAdapter } from "../../src/code/agy-agent.js";
import { createClaudeAdapter, createClaudeState } from "../../src/code/claude-agent.js";
import { createCodexAdapter } from "../../src/code/codex-agent.js";
import { createPiAdapter } from "../../src/code/pi-agent.js";
import {
  buildAgentEnv,
  buildTerminationUpdate,
  runAgent,
  type AgentAdapter,
  type RunConfig,
  type SpawnAgentProcess,
} from "../../src/code/run-agent.js";
import {
  applyCompletion,
  readCompletion,
  writeInitialSessionFile,
} from "../../src/code/session-file.js";
import { makeSink } from "../helpers.js";

const EPOCH = new Date(0).toISOString();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared runner helpers", () => {
  it("strips the unset names and keeps every other variable", () => {
    const env = buildAgentEnv(
      { PATH: "/bin", SECRET_KEY: "leak", OTHER_SECRET: "leak", KEEP: "yes", HOME: "/home/a" },
      ["SECRET_KEY", "OTHER_SECRET", "ABSENT"],
    );
    expect(env).toEqual({ PATH: "/bin", KEEP: "yes", HOME: "/home/a" });
  });

  it("builds a terminal update with captured identity", () => {
    const state = createClaudeState();
    state.sessionId = "sess-1";
    state.earlierResults = ["report"];
    expect(buildTerminationUpdate("SIGTERM", state, new Date("2026-07-02T10:00:00Z"))).toEqual({
      status: "failed",
      endedAt: "2026-07-02T10:00:00.000Z",
      exitReason: "terminated",
      sessionId: "sess-1",
      result: expect.stringContaining("report\n\n---- Later result ----\n\n"),
      contextTokens: null,
      contextCompacted: false,
      contextTokensError: null,
    });
  });

  it("drains trailing JSONL, writes completion, and strips the child environment", async () => {
    const { config, sessionFilePath } = makeRun();
    config.env = buildAgentEnv({ SECRET: "hidden", KEEP: "yes" }, ["SECRET"]);
    const script = `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s:%s"}}\\n' "$KEEP" "\${SECRET-undefined}"
printf '%s' '{"type":"turn.completed"}'`;
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      shellFixture(script),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: "thread-1",
      result: "yes:undefined",
    });
    expect(readCompletion(sessionFilePath)).toMatchObject({
      frontmatter: { status: "succeeded", agent: "codex" },
      result: "yes:undefined",
    });
  });

  it("writes a single result without a separator after an initially empty Claude result", async () => {
    const { config, sessionFilePath } = makeRun();
    const events = ["", "Report."].map((result) => ({
      type: "result",
      session_id: "claude-1",
      result,
      is_error: false,
    }));
    await runAgent(config, createClaudeAdapter(), makeSink(), shellFixture(printLines(events)));
    expect(readCompletion(sessionFilePath).result).toBe("Report.");
  });

  it.each([false, true])("keeps earlier responses before a final failure=%s", async (failed) => {
    const { config, sessionFilePath } = makeRun();
    config.nativeContext = "Claude profile work";
    const events = [
      { type: "result", session_id: "claude-1", result: "Substantive report.", is_error: false },
      { type: "result", session_id: "claude-1", result: "", is_error: false },
      {
        type: "result",
        session_id: "claude-1",
        result: failed ? "follow-up failed" : "Acknowledged.",
        is_error: failed,
      },
    ];
    const result = await runAgent(
      config,
      createClaudeAdapter(),
      makeSink(),
      shellFixture(printLines(events)),
    );
    const last = failed ? "Claude profile work: follow-up failed" : "Acknowledged.";
    expect(result).toMatchObject({ status: failed ? "failed" : "succeeded", result: last });
    expect(readCompletion(sessionFilePath).result).toBe(
      `Substantive report.\n\n---- Later result ----\n\n${last}`,
    );
  });

  it("keeps a Pi report before its follow-up acknowledgement in the durable block", async () => {
    const { config, sessionFilePath } = makeRun();
    const events = [
      {
        type: "session",
        version: 3,
        id: "pi-1",
        cwd: config.cwd,
        timestamp: EPOCH,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Report." }],
        },
      },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "text", text: "Working" }],
        },
      },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Acknowledged." }],
        },
      },
      { type: "agent_settled", aborted: false },
    ];
    const result = await runAgent(
      config,
      createPiAdapter(),
      makeSink(),
      shellFixture(printLines(events)),
    );
    expect(result).toMatchObject({ status: "succeeded", result: "Acknowledged." });
    expect(readCompletion(sessionFilePath).result).toBe(
      "Report.\n\n---- Later result ----\n\nAcknowledged.",
    );
  });

  it.each([createClaudeAdapter(), createCodexAdapter()])(
    "keeps identical durable UTF-8 and trailing JSONL output with quiet $executable runs",
    async (adapter) => {
      const text = "Résumé 🧪";
      const events =
        adapter.executable === "claude"
          ? [
              { type: "system", subtype: "init", session_id: "quiet-1" },
              { type: "assistant", message: { content: [{ type: "text", text }] } },
              { type: "result", result: "final answer", is_error: false },
            ]
          : [
              { type: "thread.started", thread_id: "quiet-1" },
              { type: "item.completed", item: { type: "agent_message", text } },
              { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
              { type: "turn.completed" },
            ];
      const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n"));
      const split = bytes.indexOf(Buffer.from("🧪")) + 2;
      const script = `${printBytes(bytes.subarray(0, split))}\nsleep 0.01\n${printBytes(bytes.subarray(split))}`;
      const bodies: string[] = [];
      for (const quiet of [false, true]) {
        const { config, sessionFilePath } = makeRun();
        config.quiet = quiet;
        const stdout = makeSink();
        const result = await runAgent(config, adapter, stdout, shellFixture(script));
        expect(result).toMatchObject({
          status: "succeeded",
          sessionId: "quiet-1",
          result: "final answer",
        });
        expect(readCompletion(sessionFilePath).result).toBe("final answer");
        if (quiet) expect(stdout.text()).toBe("");
        else expect(stdout.text()).toContain(text);
        bodies.push(readFileSync(sessionFilePath, "utf8").split("\n---\n")[1]);
      }
      expect(bodies[0]).toContain(text);
      expect(bodies[0]).not.toContain("�");
      expect(bodies[0]).toBe(bodies[1]);
    },
  );

  it("lets a Claude run wait for its background work without a time cap", () => {
    const env = buildAgentEnv(
      { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "600000" },
      [],
      {},
      createClaudeAdapter().env,
    );
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
  });

  it.each([createClaudeAdapter(), createCodexAdapter()])(
    "pipes a large literal prompt to $executable without putting it in argv",
    async (adapter) => {
      const { config } = makeRun();
      config.prompt = "`code` $(literal) '$value' \"quotes\" é\n".repeat(20_000);
      const script = `
        let prompt = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => prompt += chunk);
        process.stdin.on("end", () => {
          const lines = process.argv[1] === "claude"
            ? [{ type: "result", session_id: "claude-1", result: prompt, is_error: false }]
            : [
                { type: "thread.started", thread_id: "codex-1" },
                { type: "item.completed", item: { type: "agent_message", text: prompt } },
                { type: "turn.completed" },
              ];
          process.stdout.write(lines.map(JSON.stringify).join("\\n"));
        });
      `;
      const result = await runAgent(config, adapter, { write() {} }, (command, args, options) => {
        expect(args).not.toContain(config.prompt);
        expect(options.stdio[0]).toBe("pipe");
        return spawn(process.execPath, ["-e", script, command], options);
      });
      expect(result.status).toBe("succeeded");
      expect(result.result).toBe(config.prompt);
    },
  );

  it("writes the adapter's formatted input to the child's stdin", async () => {
    const { config } = makeRun();
    const script = `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const events = [
          { event: "init", conversation_id: "conv-1", init: {} },
          { event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: input } },
        ];
        process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
      });
    `;
    const result = await runAgent(config, createAgyAdapter(), makeSink(), nodeFixture(script));
    expect(result.status).toBe("succeeded");
    expect(result.result.endsWith("\n")).toBe(true);
    expect(JSON.parse(result.result)).toEqual({ event: "user", message: { content: "go" } });
  });

  it("stops the child once its native identity fails", async () => {
    const { config, sessionFilePath } = makeRun("conv-old");
    const marker = join(config.cwd, "prompt-executed");
    const initLine = JSON.stringify({ event: "init", conversation_id: "conv-new", init: {} });
    const script = `
      process.stdout.write(${JSON.stringify(`${initLine}\n`)});
      setTimeout(() => {
        require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");
        process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Done." } }) + "\\n");
      }, 3000);
    `;
    const adapter = createAgyAdapter();
    const result = await runAgent(config, adapter, makeSink(), nodeFixture(script));
    const expected = adapter.createState(config);
    adapter.interpretLine(initLine, expected);
    expect(result).toMatchObject({ status: "failed", result: expected.identityFailure });
    expect(readCompletion(sessionFilePath).frontmatter).toMatchObject({
      status: "failed",
      exitReason: "error",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("records a failed prompt pipe", async () => {
    const { config, sessionFilePath } = makeRun();
    config.quiet = true;
    config.prompt = "x".repeat(2_000_000);
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      nodeFixture('require("node:fs").closeSync(0); setTimeout(() => {}, 10000);'),
    );
    expect(result.status).toBe("failed");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("uses stderr for an unsuccessful process without a structured error", async () => {
    const { config } = makeRun();
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      shellFixture("printf 'service unavailable' >&2\nexit 7"),
    );
    expect(result).toMatchObject({ status: "failed", result: "service unavailable" });
  });

  it("records a startup failure", async () => {
    const { config, sessionFilePath } = makeRun();
    config.quiet = true;
    const adapter = { ...createCodexAdapter(), executable: "missing-aligndev-fixture-command" };
    const result = await runAgent(config, adapter, { write() {} });
    expect(result.status).toBe("failed");
    expect(result.result).toMatch(/ENOENT/);
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });
});

describe.each([createClaudeAdapter(), createPiAdapter()])(
  "$executable termination results",
  (adapter) => {
    it("preserves completed responses before diagnostics", () => {
      const count = 2;
      for (const activity of ["waiting", "partial", "toolUse"]) {
        const { config, sessionFilePath } = makeRun();
        const state = adapter.createState(config);
        const emit = (event: object) => adapter.interpretLine(JSON.stringify(event), state);
        const claude = adapter.executable === "claude";
        emit(
          claude
            ? { type: "system", subtype: "init", session_id: "session-1" }
            : {
                type: "session",
                version: 3,
                id: "session-1",
                cwd: config.cwd,
                timestamp: EPOCH,
              },
        );
        const reports = ["First report.", "Second report."].slice(0, count);
        for (const report of reports) {
          if (!claude) emit({ type: "message_start", message: { role: "assistant" } });
          emit(
            claude
              ? { type: "result", result: report, is_error: false }
              : {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: report }],
                  },
                },
          );
        }
        if (activity !== "waiting") {
          if (!claude) emit({ type: "message_start", message: { role: "assistant" } });
          emit(
            claude
              ? {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "Unfinished commentary" }] },
                }
              : activity === "toolUse"
                ? {
                    type: "message_end",
                    message: {
                      role: "assistant",
                      stopReason: "toolUse",
                      content: [{ type: "text", text: "Unfinished commentary" }],
                    },
                  }
                : {
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "Unfinished commentary" },
                  },
          );
        }
        applyCompletion(sessionFilePath, buildTerminationUpdate("SIGTERM", state, new Date()));
        const completion = readCompletion(sessionFilePath);
        expect(completion.frontmatter).toMatchObject({
          status: "failed",
          exitReason: "terminated",
        });
        expect(completion.result?.split("\n\n---- Later result ----\n\n").slice(0, -1)).toEqual(
          reports,
        );
        expect(completion.result).not.toContain("Unfinished commentary");
      }
    });
  },
);

type ResumeOutcome =
  | "missingIdentity"
  | "wrongIdentity"
  | "nativeFailure"
  | "authFailure"
  | "startupFailure"
  | "success";

describe("durable resume identity", () => {
  it.each(
    [createClaudeAdapter(), createCodexAdapter(), createPiAdapter()].flatMap((adapter) =>
      (["missingIdentity", "wrongIdentity"] as const).map(
        (outcome): [string, AgentAdapter, ResumeOutcome] => [adapter.executable, adapter, outcome],
      ),
    ),
  )("preserves the requested %s ID after %s", async (_name, adapter, outcome) => {
    await expectRequestedIdentity(adapter, outcome);
  });

  it.each<[ResumeOutcome, AgentAdapter]>([
    ["nativeFailure", createCodexAdapter()],
    ["authFailure", createClaudeAdapter()],
    ["startupFailure", createPiAdapter()],
    ["success", createClaudeAdapter()],
  ])("preserves the requested ID after %s", async (outcome, adapter) => {
    await expectRequestedIdentity(adapter, outcome);
  });

  it.each([undefined, "replacement-session"])(
    "preserves the requested ID on handled termination after observed ID %s",
    (id) => {
      const adapter = createClaudeAdapter();
      const { config, sessionFilePath } = makeRun("original-session");
      const state = adapter.createState(config);
      for (const event of completionEvents(adapter, id)) {
        adapter.interpretLine(JSON.stringify(event), state);
      }
      const update = buildTerminationUpdate("SIGTERM", state, new Date());
      expect(update).toMatchObject({
        status: "failed",
        exitReason: "terminated",
        sessionId: "original-session",
        result: expect.stringContaining("done\n\n---- Later result ----\n\n"),
      });
      applyCompletion(sessionFilePath, update);
      expect(readCompletion(sessionFilePath).frontmatter.sessionId).toBe("original-session");
    },
  );

  it.each([undefined, "new-session"])(
    "keeps new-session semantics with observed ID %s",
    async (id) => {
      const adapter = createCodexAdapter();
      const { config, sessionFilePath } = makeRun();
      const result = await runAgent(
        config,
        adapter,
        makeSink(),
        shellFixture(printLines(completionEvents(adapter, id))),
      );
      expect(result).toMatchObject({
        status: id === undefined ? "failed" : "succeeded",
        sessionId: id ?? null,
      });
      expect(readCompletion(sessionFilePath).frontmatter.sessionId).toBe(id ?? null);
    },
  );
});

// A resumed run keeps the requested ID whatever it observes, without taking it as native evidence.
async function expectRequestedIdentity(adapter: AgentAdapter, outcome: ResumeOutcome) {
  const { config, sessionFilePath } = makeRun("original-session");
  const id =
    outcome === "missingIdentity"
      ? undefined
      : outcome === "wrongIdentity"
        ? "replacement-session"
        : "original-session";
  const events =
    outcome !== "authFailure"
      ? completionEvents(adapter, id)
      : adapter.executable === "claude"
        ? [{ type: "assistant", error: "authentication_failed" }]
        : [];
  const failing = outcome === "nativeFailure" || outcome === "authFailure";
  const selected =
    outcome === "startupFailure"
      ? { ...adapter, executable: "missing-aligndev-fixture-command" }
      : adapter;
  const result = await runAgent(
    config,
    selected,
    makeSink(),
    outcome === "startupFailure"
      ? undefined
      : shellFixture(`${printLines(events)}\n${failing ? "exit 1" : ""}`),
  );
  const status = outcome === "success" ? "succeeded" : "failed";
  const exitReason =
    outcome === "success" ? "completed" : outcome === "authFailure" ? "auth_required" : "error";
  expect(result).toMatchObject({
    status,
    sessionId: "original-session",
    authRequired: outcome === "authFailure",
  });
  expect(readCompletion(sessionFilePath).frontmatter).toMatchObject({
    status,
    exitReason,
    sessionId: "original-session",
  });
}

function completionEvents(adapter: AgentAdapter, id: string | undefined): object[] {
  if (adapter.executable === "claude") {
    return [
      ...(id === undefined ? [] : [{ type: "system", subtype: "init", session_id: id }]),
      { type: "result", result: "done", is_error: false },
    ];
  }
  if (adapter.executable === "codex") {
    return [
      ...(id === undefined ? [] : [{ type: "thread.started", thread_id: id }]),
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed" },
    ];
  }
  return [
    ...(id === undefined
      ? []
      : [{ type: "session", version: 3, id, cwd: "/fixture", timestamp: EPOCH }]),
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    },
    { type: "agent_settled", aborted: false },
  ];
}

describe("pi through the shared runner", () => {
  it("transports literal stdin, split UTF-8, Unicode separators and trailing JSON quietly", async () => {
    const { config, sessionFilePath } = makeRun();
    config.quiet = true;
    config.prompt = "Résumé 🧪\u2028inside\u2029JSON $(literal) `code`\n";
    const stdout = makeSink();
    const script = `
      let prompt = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => prompt += chunk);
      process.stdin.on("end", () => {
        const events = [
          { type: "session", version: 3, id: "pi-session", timestamp: new Date().toISOString(), cwd: process.cwd() },
          { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: prompt }] } },
          { type: "agent_settled", aborted: false },
        ];
        const bytes = Buffer.from(events.map(JSON.stringify).join("\\r\\n"));
        const split = bytes.indexOf(Buffer.from("🧪")) + 2;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      });
    `;
    const result = await runAgent(config, createPiAdapter(), stdout, (command, args, options) => {
      expect(command).toBe("pi");
      expect(args).toEqual(["--mode", "json"]);
      expect(args).not.toContain(config.prompt);
      return spawn(process.execPath, ["-e", script], options);
    });
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: "pi-session",
      result: config.prompt,
    });
    expect(readFileSync(sessionFilePath, "utf8")).toContain(config.prompt);
    expect(readFileSync(sessionFilePath, "utf8")).not.toContain("�");
    expect(stdout.text()).toBe("");
  });

  it("rejects an aborted run", async () => {
    const { config, sessionFilePath } = makeRun();
    const events = [
      { type: "session", version: 3, id: "pi-session", timestamp: EPOCH, cwd: config.cwd },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "answer" }],
        },
      },
      { type: "agent_settled", aborted: true },
    ];
    const result = await runAgent(
      config,
      createPiAdapter(),
      makeSink(),
      shellFixture(printLines(events)),
    );
    expect(result.status).toBe("failed");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("keeps startup authentication failures durable and non-generic", async () => {
    const { config, sessionFilePath } = makeRun();
    const result = await runAgent(
      config,
      createPiAdapter(),
      makeSink(),
      shellFixture("printf 'No API key found for example.' >&2\nexit 1"),
    );
    expect(result).toMatchObject({ status: "failed", authRequired: true });
    const completion = readCompletion(sessionFilePath);
    expect(completion.frontmatter.exitReason).toBe("auth_required");
    expect(completion.result).toBe(
      "login instructions\n\nAgent error:\n\nNo API key found for example.",
    );
  });
});

function makeRun(resume?: string): { config: RunConfig; sessionFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "aligndev-runner-"));
  dirs.push(dir);
  const sessionFilePath = join(dir, "session.md");
  writeInitialSessionFile(sessionFilePath, {
    status: "running",
    agent: "codex",
    profile: null,
    protocol: null,
    ticket: null,
    model: null,
    effort: null,
    sessionId: resume ?? null,
    command: `aligndev code ${resume === undefined ? "new" : `resume ${resume}`} --message go`,
    meta: null,
    pid: process.pid,
    pidStartTime: null,
    machineId: "test-machine",
    cwd: dir,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    exitReason: null,
    contextTokens: null,
    contextCompacted: false,
    contextTokensError: null,
  });
  return {
    sessionFilePath,
    config: {
      prompt: "go",
      sessionFilePath,
      authenticationFailure: { instructions: "login instructions", errorLabel: "Agent error:" },
      cwd: dir,
      resume,
      executableModel: undefined,
      effort: undefined,
      skipPermissions: false,
      additionalDirectories: [],
      env: {},
    },
  };
}

function nodeFixture(script: string): SpawnAgentProcess {
  return (_command, _args, options) => spawn(process.execPath, ["-e", script], options);
}

// Reads the prompt to its end, as an agent does, then runs `script`.
function shellFixture(script: string): SpawnAgentProcess {
  return (_command, _args, options) =>
    spawn("/bin/sh", ["-c", `while read -r _; do :; done\n${script}`], options);
}

// Shell lines printing the values as JSON lines; byte arrays print raw, so a chunk may split UTF-8.
function printLines(values: object[], separator = "\n"): string {
  const text = values.map((value) => JSON.stringify(value)).join(separator);
  return printBytes(Buffer.from(text));
}

function printBytes(bytes: Buffer): string {
  const escaped = [...bytes]
    .map((byte) =>
      byte >= 0x20 && byte < 0x7f && byte !== 0x27 && byte !== 0x5c && byte !== 0x25
        ? String.fromCharCode(byte)
        : `\\${byte.toString(8).padStart(3, "0")}`,
    )
    .join("");
  return `printf '${escaped}'`;
}
