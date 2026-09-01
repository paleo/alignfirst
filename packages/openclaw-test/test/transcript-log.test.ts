import { describe, expect, it } from "vitest";
import {
  aggregateAgentToolCalls,
  hasOpenTurn,
  readTranscriptCost,
  type TranscriptSession,
} from "../src/transcript-log.js";

// A session transcript whose messages carry the given assistant turns. Each
// turn is one assistant message: its tool calls (`[id, name, args]`) and
// optional cost. `toolResult` messages are appended so `result` gets attached.
function session(opts: {
  sessionKey: string;
  turns: { calls?: [string, string, unknown][]; costTotal?: number }[];
}): TranscriptSession {
  const messages: unknown[] = [];
  for (const turn of opts.turns) {
    messages.push({
      role: "assistant",
      timestamp: 1_756_700_000_000,
      content: (turn.calls ?? []).map(([id, name, args]) => ({
        type: "toolCall",
        id,
        name,
        arguments: args,
      })),
      ...(turn.costTotal !== undefined ? { usage: { cost: { total: turn.costTotal } } } : {}),
    });
    for (const [id] of turn.calls ?? []) {
      messages.push({ role: "toolResult", toolCallId: id, isError: false, content: "ok" });
    }
  }
  return { sessionKey: opts.sessionKey, sessionId: `${opts.sessionKey}-id`, messages };
}

const channel = "agent:main:discord-mock:channel:channel:a1-x";
const thread = "agent:main:discord-mock:channel:thread:a1-x/thread-1";

describe("aggregateAgentToolCalls", () => {
  it("unions tool calls across channel and thread sessions", () => {
    const sessions = [
      session({
        sessionKey: channel,
        turns: [{ calls: [["c1", "read", { path: "~/.agents/skills/x/SKILL.md" }]] }],
      }),
      session({
        sessionKey: thread,
        turns: [
          { calls: [["t1", "read", { path: "~/projects/nimbus/DEVELOPERS.md" }]] },
          { calls: [["t2", "exec", { command: "pnpm workspace --guide" }]] },
        ],
      }),
    ];
    const calls = aggregateAgentToolCalls(sessions);
    expect(calls.map((c) => c.toolUseId)).toEqual(["c1", "t1", "t2"]);
    expect(calls.find((c) => c.toolUseId === "c1")?.sessionKey).toBe(channel);
    expect(calls.find((c) => c.toolUseId === "t1")?.sessionKey).toBe(thread);
    expect(calls.find((c) => c.toolUseId === "t2")?.turn).toBe(2);
    expect(calls.find((c) => c.toolUseId === "t1")?.input).toEqual({
      path: "~/projects/nimbus/DEVELOPERS.md",
    });
    expect(calls.find((c) => c.toolUseId === "t1")?.result).toEqual({
      isError: false,
      content: "ok",
    });
  });

  it("dedupes a toolUseId seen in more than one session transcript", () => {
    const sessions = [
      session({ sessionKey: channel, turns: [{ calls: [["dup", "read", {}]] }] }),
      session({ sessionKey: thread, turns: [{ calls: [["dup", "read", {}]] }] }),
    ];
    expect(aggregateAgentToolCalls(sessions)).toHaveLength(1);
  });

  it("skips malformed messages but keeps the rest", () => {
    const broken: TranscriptSession = {
      sessionKey: thread,
      sessionId: "broken-id",
      messages: ["garbage", { role: "assistant", content: "plain text" }],
    };
    const ok = session({ sessionKey: channel, turns: [{ calls: [["c1", "exec", {}]] }] });
    expect(aggregateAgentToolCalls([ok, broken]).map((c) => c.toolUseId)).toEqual(["c1"]);
  });

  it("leaves startedAt absent when the message carries no timestamp", () => {
    const noTimestamp: TranscriptSession = {
      sessionKey: thread,
      sessionId: "no-ts-id",
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "exec", arguments: {} }],
        },
      ],
    };
    const [call] = aggregateAgentToolCalls([noTimestamp]);
    expect(call?.toolUseId).toBe("t1");
    expect(call?.startedAt).toBeUndefined();
    expect("startedAt" in (call ?? {})).toBe(false);
  });
});

describe("readTranscriptCost", () => {
  it("sums assistant cost and counts turns across sessions", () => {
    const sessions = [
      session({ sessionKey: channel, turns: [{ costTotal: 0.01 }] }),
      session({ sessionKey: thread, turns: [{ costTotal: 0.02 }, { costTotal: 0.03 }] }),
    ];
    expect(readTranscriptCost({ databases: 1, sessions })).toEqual({ cost: 0.06, turns: 3 });
  });

  it("counts only cost-bearing assistant turns", () => {
    const sessions = [session({ sessionKey: channel, turns: [{}] })];
    expect(readTranscriptCost({ databases: 1, sessions })).toEqual({ cost: 0, turns: 0 });
  });

  it("skips a usage whose cost.total is not a number", () => {
    const sessions: TranscriptSession[] = [
      {
        sessionKey: channel,
        sessionId: "partial-usage-id",
        messages: [
          { role: "assistant", usage: { cost: {} } },
          { role: "assistant", usage: { cost: { total: "0.5" } } },
          { role: "assistant", usage: { cost: { total: 0.02 } } },
        ],
      },
    ];
    expect(readTranscriptCost({ databases: 1, sessions })).toEqual({ cost: 0.02, turns: 1 });
  });
});

describe("hasOpenTurn", () => {
  function sessionEndingWith(last: unknown): TranscriptSession {
    return { sessionKey: thread, sessionId: "s-id", messages: [{ role: "user" }, last] };
  }

  it("is open on a trailing tool result", () => {
    expect(hasOpenTurn([sessionEndingWith({ role: "toolResult", toolCallId: "t1" })])).toBe(true);
  });

  it("is open on a trailing assistant stop for tool use", () => {
    expect(hasOpenTurn([sessionEndingWith({ role: "assistant", stopReason: "toolUse" })])).toBe(
      true,
    );
  });

  it("is closed on a trailing turn-final assistant message", () => {
    expect(hasOpenTurn([sessionEndingWith({ role: "assistant", stopReason: "stop" })])).toBe(false);
  });

  it("ignores a trailing user message — the sibling session may carry the reply", () => {
    expect(hasOpenTurn([sessionEndingWith({ role: "user" })])).toBe(false);
    expect(hasOpenTurn([{ sessionKey: thread, sessionId: "s-id", messages: [] }])).toBe(false);
  });
});
