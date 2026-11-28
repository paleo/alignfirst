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
});

describe("readTranscriptCost", () => {
  it.each<{
    name: string;
    sessions: TranscriptSession[];
    expected: { cost: number; turns: number };
  }>([
    {
      name: "sums assistant cost and counts turns across sessions",
      sessions: [
        session({ sessionKey: channel, turns: [{ costTotal: 0.01 }] }),
        session({ sessionKey: thread, turns: [{ costTotal: 0.02 }, { costTotal: 0.03 }] }),
      ],
      expected: { cost: 0.06, turns: 3 },
    },
    {
      name: "counts only cost-bearing assistant turns",
      sessions: [session({ sessionKey: channel, turns: [{}] })],
      expected: { cost: 0, turns: 0 },
    },
    {
      name: "skips a usage whose cost.total is not a number",
      sessions: [
        {
          sessionKey: channel,
          sessionId: "partial-usage-id",
          messages: [
            { role: "assistant", usage: { cost: {} } },
            { role: "assistant", usage: { cost: { total: "0.5" } } },
            { role: "assistant", usage: { cost: { total: 0.02 } } },
          ],
        },
      ],
      expected: { cost: 0.02, turns: 1 },
    },
  ])("$name", ({ sessions, expected }) => {
    expect(readTranscriptCost({ databases: 1, sessions })).toEqual(expected);
  });
});

describe("hasOpenTurn", () => {
  it.each<{ name: string; messages: unknown[]; open: boolean }>([
    {
      name: "is open on a trailing tool result",
      messages: [{ role: "user" }, { role: "toolResult", toolCallId: "t1" }],
      open: true,
    },
    {
      name: "is open on a trailing assistant stop for tool use",
      messages: [{ role: "user" }, { role: "assistant", stopReason: "toolUse" }],
      open: true,
    },
    {
      name: "is closed on a trailing turn-final assistant message",
      messages: [{ role: "user" }, { role: "assistant", stopReason: "stop" }],
      open: false,
    },
    {
      name: "ignores a trailing user message, which the sibling session may answer",
      messages: [{ role: "user" }, { role: "user" }],
      open: false,
    },
    { name: "is closed on an empty session", messages: [], open: false },
  ])("$name", ({ messages, open }) => {
    expect(hasOpenTurn([{ sessionKey: thread, sessionId: "s-id", messages }])).toBe(open);
  });
});
