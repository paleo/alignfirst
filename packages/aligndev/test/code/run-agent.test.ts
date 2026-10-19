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
  type RunConfig,
  type SpawnAgentProcess,
} from "../../src/code/run-agent.js";
import { readCompletion, writeInitialSessionFile } from "../../src/code/session-file.js";
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
    expect(buildTerminationUpdate("SIGTERM", state, new Date("2026-07-02T10:00:00Z"))).toEqual({
      status: "failed",
      endedAt: "2026-07-02T10:00:00.000Z",
      exitReason: "terminated",
      sessionId: "sess-1",
      result: "Terminated by SIGTERM before completion.",
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

function makeRun(): { config: RunConfig; sessionFilePath: string } {
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
    sessionId: null,
    command: "aligndev code new --message go",
    meta: null,
    pid: process.pid,
    pidStartTime: null,
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
