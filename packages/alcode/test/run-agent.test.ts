import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeAdapter, createClaudeState } from "../src/claude-agent.js";
import { createCodexAdapter } from "../src/codex-agent.js";
import {
  buildAgentEnv,
  buildTerminationUpdate,
  runAgent,
  type RunConfig,
  type SpawnAgentProcess,
} from "../src/run-agent.js";
import { readCompletion, writeInitialSessionFile } from "../src/session-file.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared runner helpers", () => {
  it("strips wrapper variables and explicitly unset names", () => {
    const env = buildAgentEnv(
      {
        PATH: "/bin",
        ALIGNFIRST_CODE_AGENT: "codex",
        ALIGNFIRST_CODE_UNSET: "SECRET_KEY",
        SECRET_KEY: "leak",
        KEEP: "yes",
      },
      ["SECRET_KEY"],
    );
    expect(env).toEqual({ PATH: "/bin", KEEP: "yes" });
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
    });
  });

  it("drains trailing JSONL, writes completion, and strips the child environment", async () => {
    const { config, sessionFilePath } = makeRun();
    config.env = { ALIGNFIRST_CODE_AGENT: "codex", SECRET: "hidden", KEEP: "yes" };
    config.unset = ["SECRET"];
    const script = `
      const lines = [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "item.completed", item: { type: "agent_message", text: String(process.env.KEEP) + ":" + String(process.env.SECRET) + ":" + String(process.env.ALIGNFIRST_CODE_AGENT) } },
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
      result: "yes:undefined:undefined",
    });
    expect(readCompletion(sessionFilePath)).toMatchObject({
      frontmatter: { status: "succeeded", agent: "codex" },
      result: "yes:undefined:undefined",
    });
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
            ? [{ type: "result", result: prompt, is_error: false }]
            : [
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

  it("records a failed prompt pipe without an unhandled stream error", async () => {
    const { config, sessionFilePath } = makeRun();
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

  it("turns startup failure into a durable failed completion", async () => {
    const { config, sessionFilePath } = makeRun();
    const adapter = { ...createCodexAdapter(), executable: "missing-alcode-fixture-command" };
    const result = await runAgent(config, adapter, { write() {} });
    expect(result.status).toBe("failed");
    expect(result.result).toMatch(/ENOENT/);
    expect(readCompletion(sessionFilePath).frontmatter.status).toBe("failed");
  });
});

function makeRun(): { config: RunConfig; sessionFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alcode-runner-"));
  dirs.push(dir);
  const sessionFilePath = join(dir, "session.md");
  writeInitialSessionFile(sessionFilePath, {
    status: "running",
    agent: "codex",
    protocol: null,
    ticket: null,
    model: null,
    sessionId: null,
    command: "alcode new --message go",
    meta: null,
    pid: process.pid,
    pidStartTime: null,
    cwd: dir,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    exitReason: null,
  });
  return {
    sessionFilePath,
    config: {
      prompt: "go",
      sessionFilePath,
      cwd: dir,
      executableModel: undefined,
      skipPermissions: false,
      unset: [],
      env: {},
    },
  };
}

function nodeFixture(script: string): SpawnAgentProcess {
  return (_command, _args, options) => spawn(process.execPath, ["-e", script], options);
}
