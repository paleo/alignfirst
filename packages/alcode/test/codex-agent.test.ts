import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assessCodexState,
  buildCodexArgs,
  createCodexAdapter,
  createCodexState,
  interpretCodexLine,
} from "../src/codex-agent.js";
import type { RunConfig } from "../src/run-agent.js";

const BASE: RunConfig = {
  prompt: "do the thing",
  sessionFilePath: "/tmp/x.md",
  cwd: "/proj",
  executableModel: undefined,
  skipPermissions: false,
  unset: [],
  env: {},
};

describe("Codex argv", () => {
  it("builds new and resumed commands with normal sandboxing", () => {
    expect(buildCodexArgs(BASE)).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-"]);
    expect(
      buildCodexArgs({ ...BASE, resume: "thread-1", executableModel: "gpt-5.6-terra" }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5.6-terra",
      "resume",
      "thread-1",
      "-",
    ]);
  });

  it("replaces the sandbox with dangerous bypass", () => {
    expect(buildCodexArgs({ ...BASE, skipPermissions: true })).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
  });
});

describe("Codex protocol", () => {
  it("captures messages as the transcript and intentionally omits tool lifecycle items", () => {
    const state = createCodexState();
    const rendered = [
      event(state, { type: "thread.started", thread_id: "thread-1" }),
      event(state, { type: "item.completed", item: { type: "command_execution", command: "pwd" } }),
      event(state, { type: "item.completed", item: { type: "agent_message", text: "first" } }),
      event(state, { type: "item.completed", item: { type: "agent_message", text: "last" } }),
      event(state, { type: "turn.completed", usage: { input_tokens: 1 } }),
    ];
    expect(rendered).toEqual(["[init] session thread-1", undefined, "first", "last", undefined]);
    expect(assessCodexState(state)).toMatchObject({
      succeeded: true,
      sessionId: "thread-1",
      result: "last",
    });
  });

  it("fails on missing completion or missing result", () => {
    const incomplete = createCodexState();
    event(incomplete, { type: "item.completed", item: { type: "agent_message", text: "answer" } });
    expect(assessCodexState(incomplete).succeeded).toBe(false);

    const empty = createCodexState();
    event(empty, { type: "turn.completed" });
    expect(assessCodexState(empty).succeeded).toBe(false);
  });

  it.each([
    { type: "turn.failed", error: { message: "turn broke" } },
    { type: "error", message: "service broke" },
    { type: "item.completed", item: { type: "error", message: "item broke" } },
  ])("preserves structured failures", (failure) => {
    const state = createCodexState();
    expect(event(state, failure)).toMatch(/^\[error\]/);
    expect(assessCodexState(state).error).toMatch(/broke/);
  });

  it("renders malformed lines without establishing success", () => {
    const state = createCodexState();
    expect(interpretCodexLine("not json", state)).toBe("[unparsed] not json");
    expect(assessCodexState(state).succeeded).toBe(false);
  });

  it("recognizes explicit login evidence but not generic authorization or model failures", () => {
    const login = createCodexState();
    event(login, { type: "error", message: "Not logged in. Run codex login." });
    expect(assessCodexState(login).authEvidence).toBe(true);

    for (const message of ["HTTP 401", "403 forbidden", "model is unavailable"]) {
      const state = createCodexState();
      event(state, { type: "error", message });
      expect(assessCodexState(state).authEvidence).toBe(false);
    }
    const adapter = createCodexAdapter();
    expect(adapter.isAuthenticationError("Please run codex login to continue.")).toBe(true);
    expect(adapter.isAuthenticationError("HTTP 401 unauthorized")).toBe(false);
  });

  it("ignores auth-looking assistant text when the run recovers", () => {
    const state = createCodexState();
    event(state, {
      type: "item.completed",
      item: { type: "agent_message", text: "Not logged in, but this is ordinary output" },
    });
    event(state, { type: "turn.completed" });
    expect(assessCodexState(state)).toMatchObject({ succeeded: true, authEvidence: false });
  });

  it("reads the context window from the thread rollout, not the cumulative stream total", () => {
    const state = completedState("thread-a", { streamTotal: 176_122 });
    writeRollout("thread-a", [
      { occupancy: 20_000, total: 40_000 },
      { occupancy: 33_807, total: 176_122 },
    ]);
    const assessment = assessCodexState(state);
    expect(assessment.contextTokens).toBe(33_807);
    expect(assessment.contextCompacted).toBe(false);
    expect(assessment.contextTokensError).toBeUndefined();
  });

  it("reports a compacted thread when occupancy fell during the run", () => {
    const state = completedState("thread-b", { streamTotal: 500_000 });
    writeRollout("thread-b", [
      { occupancy: 198_667, total: 300_000 },
      { occupancy: 20_579, total: 500_000 },
    ]);
    const assessment = assessCodexState(state);
    expect(assessment.contextTokens).toBe(20_579);
    expect(assessment.contextCompacted).toBe(true);
  });

  // The rollout total must match the stream's, so a Codex format change is reported instead of
  // producing a plausible wrong figure.
  it("reports an error when the rollout total disagrees with the stream", () => {
    const state = completedState("thread-c", { streamTotal: 176_122 });
    writeRollout("thread-c", [{ occupancy: 33_807, total: 999 }]);
    const assessment = assessCodexState(state);
    expect(assessment.contextTokens).toBeUndefined();
    expect(assessment.contextTokensError).toMatch(/does not match the stream total/);
  });

  it("reports an error when no rollout exists for the thread", () => {
    const assessment = assessCodexState(completedState("thread-missing", { streamTotal: 1_000 }));
    expect(assessment.contextTokens).toBeUndefined();
    expect(assessment.contextTokensError).toMatch(/No Codex rollout found/);
  });

  it("reports an error when the completed turn carries no usage", () => {
    const state = createCodexState();
    event(state, { type: "thread.started", thread_id: "thread-d" });
    event(state, { type: "turn.completed" });
    const assessment = assessCodexState(state);
    expect(assessment.contextTokens).toBeUndefined();
    expect(assessment.contextTokensError).toMatch(/no turn.completed usage/);
  });
});

function event(state: ReturnType<typeof createCodexState>, value: unknown): string | undefined {
  return interpretCodexLine(JSON.stringify(value), state);
}

let codexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "alcode-codex-home-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function completedState(threadId: string, options: { streamTotal: number }) {
  const state = createCodexState();
  event(state, { type: "thread.started", thread_id: threadId });
  event(state, {
    type: "turn.completed",
    // Codex counts cached input inside `input_tokens`; the event carries the thread's total.
    usage: { input_tokens: options.streamTotal - 100, output_tokens: 100 },
  });
  return state;
}

interface RolloutUsage {
  occupancy: number;
  total: number;
}

function writeRollout(threadId: string, usages: RolloutUsage[]): void {
  const dir = join(codexHome ?? "", "sessions", "2026", "09", "16");
  mkdirSync(dir, { recursive: true });
  const lines = usages.map((usage) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: usage.occupancy - 1, output_tokens: 1 },
          total_token_usage: { input_tokens: usage.total - 1, output_tokens: 1 },
          model_context_window: 258_400,
        },
      },
    }),
  );
  writeFileSync(
    join(dir, `rollout-2026-09-16T13-21-55-${threadId}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}
