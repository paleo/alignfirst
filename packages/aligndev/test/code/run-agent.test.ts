import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  it("strips the assistant's coding-agent session identity and keeps its settings", () => {
    const env = buildAgentEnv(
      {
        PATH: "/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s-1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_SESSION_ATTENDED: "1",
        CLAUDE_CODE_EXECPATH: "/usr/bin/claude",
        CODEX_THREAD_ID: "t-1",
        CODEX_SANDBOX_NETWORK_DISABLED: "1",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
      [],
    );
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1" });
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
      result: "report\n\n---- Later result ----\n\nTerminated by SIGTERM before completion.",
      contextTokens: null,
      contextCompacted: false,
      contextTokensError: null,
    });
  });

  it("drains trailing JSONL, writes completion, and strips the child environment", async () => {
    const { config, sessionFilePath } = makeRun();
    config.env = buildAgentEnv({ SECRET: "hidden", KEEP: "yes" }, ["SECRET"]);
    const script = `
      const lines = [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "item.completed", item: { type: "agent_message", text: String(process.env.KEEP) + ":" + String(process.env.SECRET) } },
        { type: "turn.completed" },
      ];
      process.stdout.write(lines.map(JSON.stringify).join("\\n"));
    `;
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      nodeFixture(script),
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
    await runAgent(
      config,
      createClaudeAdapter(),
      makeSink(),
      nodeFixture(
        `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});`,
      ),
    );
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
    const script = `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});`;
    const result = await runAgent(config, createClaudeAdapter(), makeSink(), nodeFixture(script));
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
        timestamp: new Date().toISOString(),
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
    const script = `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});`;
    const result = await runAgent(config, createPiAdapter(), makeSink(), nodeFixture(script));
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
      const script = `
        const bytes = Buffer.from(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});
        const split = bytes.indexOf(Buffer.from("🧪")) + 2;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      `;
      const bodies: string[] = [];
      for (const quiet of [false, true]) {
        const { config, sessionFilePath } = makeRun();
        config.quiet = quiet;
        const stdout = makeSink();
        const result = await runAgent(config, adapter, stdout, nodeFixture(script));
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

  it("lets a Claude run wait for its background work without a time cap", async () => {
    const { config } = makeRun();
    config.env = buildAgentEnv(
      { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "600000" },
      [],
      {},
      createClaudeAdapter().env,
    );
    const script = `
      const result = String(process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS);
      process.stdout.write(JSON.stringify({ type: "result", session_id: "claude-1", result, is_error: false }));
    `;
    const result = await runAgent(
      config,
      createClaudeAdapter(),
      { write() {} },
      nodeFixture(script),
    );
    expect(result).toMatchObject({ status: "succeeded", result: "0" });
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

  it.each([false, true])("records a failed prompt pipe with quiet=%s", async (quiet) => {
    const { config, sessionFilePath } = makeRun();
    config.quiet = quiet;
    config.prompt = "x".repeat(2_000_000);
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      nodeFixture('require("node:fs").closeSync(0); setTimeout(() => {}, 10000);'),
    );
    expect(result.status).toBe("failed");
    expect(result.result).toContain("Could not send prompt:");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("uses stderr for an unsuccessful process without a structured error", async () => {
    const { config } = makeRun();
    const result = await runAgent(
      config,
      createCodexAdapter(),
      { write() {} },
      nodeFixture('process.stderr.write("service unavailable"); process.exit(7);'),
    );
    expect(result).toMatchObject({ status: "failed", result: "service unavailable" });
  });

  it.each([false, true])("records startup failure with quiet=%s", async (quiet) => {
    const { config, sessionFilePath } = makeRun();
    config.quiet = quiet;
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
    it.each([0, 1, 2])("preserves %i completed responses before diagnostics", (count) => {
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
                timestamp: new Date().toISOString(),
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
        expect(readCompletion(sessionFilePath)).toMatchObject({
          frontmatter: { status: "failed", exitReason: "terminated" },
          result: [...reports, "Terminated by SIGTERM before completion."].join(
            "\n\n---- Later result ----\n\n",
          ),
        });
      }
    });
  },
);

describe.each([createClaudeAdapter(), createCodexAdapter(), createPiAdapter()])(
  "$executable durable resume identity",
  (adapter) => {
    it.each([
      "missingIdentity",
      "wrongIdentity",
      "nativeFailure",
      "authFailure",
      "startupFailure",
      "success",
    ])(
      "preserves the requested ID after %s without using it as native evidence",
      async (outcome) => {
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
        const script = `
        process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});
        ${outcome === "authFailure" ? 'process.stderr.write("Not logged in. Please run /login.\\nNo API key found for openai.");' : ""}
        process.exitCode = ${outcome === "nativeFailure" || outcome === "authFailure" ? 1 : 0};
      `;
        const selected =
          outcome === "startupFailure"
            ? { ...adapter, executable: "missing-aligndev-fixture-command" }
            : adapter;
        const result = await runAgent(
          config,
          selected,
          makeSink(),
          outcome === "startupFailure" ? undefined : nodeFixture(script),
        );
        const status = outcome === "success" ? "succeeded" : "failed";
        const exitReason =
          outcome === "success"
            ? "completed"
            : outcome === "authFailure"
              ? "auth_required"
              : "error";
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
      },
    );

    it.each([undefined, "original-session", "replacement-session"])(
      "preserves the requested ID on handled termination after observed ID %s",
      (id) => {
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
          result: "done\n\n---- Later result ----\n\nTerminated by SIGTERM before completion.",
        });
        applyCompletion(sessionFilePath, update);
        expect(readCompletion(sessionFilePath).frontmatter).toMatchObject({
          status: "failed",
          exitReason: "terminated",
          sessionId: "original-session",
        });
      },
    );

    it.each([undefined, "new-session"])(
      "keeps new-session semantics with observed ID %s",
      async (id) => {
        const { config, sessionFilePath } = makeRun();
        const events = completionEvents(adapter, id);
        const result = await runAgent(
          config,
          adapter,
          makeSink(),
          nodeFixture(
            `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});`,
          ),
        );
        expect(result).toMatchObject({
          status: id === undefined ? "failed" : "succeeded",
          sessionId: id ?? null,
        });
        expect(readCompletion(sessionFilePath).frontmatter.sessionId).toBe(id ?? null);
      },
    );
  },
);

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
      : [
          { type: "session", version: 3, id, cwd: "/fixture", timestamp: new Date().toISOString() },
        ]),
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    },
    { type: "agent_settled", aborted: false },
  ];
}

describe("pi through the shared runner", () => {
  it("sanitizes only the child identity and preserves storage, credentials and generic markers", () => {
    const env = {
      CODEX_THREAD_ID: "parent",
      PI_CODING_AGENT: "true",
      AI_AGENT: "pi",
      PI_SESSION_ID: "parent",
      PI_SESSION_FILE: "/parent.jsonl",
      PI_PROVIDER: "provider",
      PI_MODEL: "model",
      PI_REASONING_LEVEL: "high",
      PI_CODING_AGENT_DIR: "/config",
      PI_CODING_AGENT_SESSION_DIR: "/sessions",
      OPENAI_API_KEY: "credential",
    };
    expect(buildAgentEnv(env, [])).toEqual({
      PI_CODING_AGENT_DIR: "/config",
      PI_CODING_AGENT_SESSION_DIR: "/sessions",
      OPENAI_API_KEY: "credential",
    });
    expect(env.CODEX_THREAD_ID).toBe("parent");
    expect(env.AI_AGENT).toBe("pi");
    expect(buildAgentEnv({ AI_AGENT: "other", PI_CODING_AGENT: "false" }, [])).toEqual({
      AI_AGENT: "other",
      PI_CODING_AGENT: "false",
    });
    expect(buildAgentEnv(env, ["OPENAI_API_KEY"]).OPENAI_API_KEY).toBeUndefined();
  });

  it.each([false, true])(
    "transports literal stdin, split UTF-8, Unicode separators and trailing JSON with quiet=%s",
    async (quiet) => {
      const { config, sessionFilePath } = makeRun();
      config.quiet = quiet;
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
      expect(stdout.text()).toBe(quiet ? "" : `[init] session pi-session\n${config.prompt}\n`);
    },
  );

  it.each([
    [0, false, false],
    [7, true, false],
    [0, true, true],
  ])("rejects exit=%s settled=%s aborted=%s", async (exit, settled, aborted) => {
    const { config, sessionFilePath } = makeRun();
    const script = `
      const events = [
        { type: "session", version: 3, id: "pi-session", timestamp: new Date().toISOString(), cwd: process.cwd() },
        { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] } },
        ...(${settled} ? [{ type: "agent_settled", aborted: ${aborted} }] : []),
      ];
      process.stdout.write(events.map(JSON.stringify).join("\\n"));
      process.exitCode = ${exit};
    `;
    const result = await runAgent(config, createPiAdapter(), makeSink(), nodeFixture(script));
    expect(result.status).toBe("failed");
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });

  it("preserves explicit compaction and missing usage when cancelled", () => {
    const { config } = makeRun();
    const adapter = createPiAdapter();
    const state = adapter.createState(config);
    adapter.interpretLine(
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: new Date().toISOString(),
        cwd: config.cwd,
      }),
      state,
    );
    adapter.interpretLine(
      JSON.stringify({ type: "compaction_end", aborted: false, result: { summary: "compacted" } }),
      state,
    );
    expect(buildTerminationUpdate("SIGTERM", state, new Date())).toMatchObject({
      exitReason: "terminated",
      sessionId: "pi-session",
      contextCompacted: true,
      contextTokens: null,
      contextTokensError: expect.stringContaining("latest assistant"),
    });
  });

  it("keeps startup authentication failures durable and non-generic", async () => {
    const { config, sessionFilePath } = makeRun();
    const result = await runAgent(
      config,
      createPiAdapter(),
      makeSink(),
      nodeFixture('process.stderr.write("No API key found for openai."); process.exitCode = 1;'),
    );
    expect(result).toMatchObject({ status: "failed", authRequired: true });
    expect(readCompletion(sessionFilePath).frontmatter.exitReason).toBe("auth_required");
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
      cwd: dir,
      resume,
      executableModel: undefined,
      skipPermissions: false,
      additionalDirectories: [],
      env: {},
    },
  };
}

function nodeFixture(script: string): SpawnAgentProcess {
  return (_command, _args, options) => spawn(process.execPath, ["-e", script], options);
}
