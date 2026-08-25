import { describe, expect, it } from "vitest";
import {
  aggregateAgentToolCalls,
  aggregateCost,
  latestCompletedPerSession,
  type TrajectoryEvent,
} from "../src/trajectory-log.js";

// A `model.completed` event whose snapshot carries the given assistant turns.
// Each turn is one assistant message: its tool calls (`[id, name, args]`) and
// optional cost. `toolResult` messages are appended so `result` gets attached.
function completed(opts: {
  sessionKey: string;
  ts: string;
  turns: { calls?: [string, string, unknown][]; costTotal?: number }[];
  truncated?: boolean;
}): TrajectoryEvent {
  const messages: unknown[] = [];
  for (const turn of opts.turns) {
    messages.push({
      role: "assistant",
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
  return {
    type: "model.completed",
    sessionKey: opts.sessionKey,
    ts: opts.ts,
    data: { messagesSnapshot: messages, ...(opts.truncated ? { truncated: true } : {}) },
  };
}

const channel = "agent:main:discord-mock:channel:channel:a1-x";
const thread = "agent:main:discord-mock:channel:thread:a1-x/thread-1";

describe("latestCompletedPerSession", () => {
  it("keeps only the latest event per sessionKey", () => {
    const events: TrajectoryEvent[] = [
      completed({ sessionKey: thread, ts: "2026-01-01T00:00:01Z", turns: [{}] }),
      completed({ sessionKey: thread, ts: "2026-01-01T00:00:09Z", turns: [{}, {}] }),
      completed({ sessionKey: channel, ts: "2026-01-01T00:00:05Z", turns: [{}] }),
    ];
    const latest = latestCompletedPerSession(events);
    expect(latest).toHaveLength(2);
    const threadEvent = latest.find((e) => e.sessionKey === thread);
    expect(threadEvent?.ts).toBe("2026-01-01T00:00:09Z");
  });

  it("falls back to the newest usable snapshot when the latest event is capped", () => {
    const usable = completed({
      sessionKey: thread,
      ts: "2026-01-01T00:00:05Z",
      turns: [{ calls: [["t1", "exec", { command: "alcode …" }]] }],
    });
    const capped: TrajectoryEvent = {
      type: "model.completed",
      sessionKey: thread,
      ts: "2026-01-01T00:00:09Z",
      data: { messagesSnapshot: "…[truncated]", truncated: true } as TrajectoryEvent["data"],
    };
    const latest = latestCompletedPerSession([usable, capped]);
    expect(latest).toHaveLength(1);
    expect(latest[0].ts).toBe("2026-01-01T00:00:05Z");
    expect(aggregateAgentToolCalls(latest)).toHaveLength(1);
  });

  it("keeps the newest event when a session has no usable snapshot", () => {
    const capped: TrajectoryEvent = {
      type: "model.completed",
      sessionKey: thread,
      ts: "2026-01-01T00:00:09Z",
      data: { messagesSnapshot: "…[truncated]", truncated: true } as TrajectoryEvent["data"],
    };
    const latest = latestCompletedPerSession([capped]);
    expect(latest).toHaveLength(1);
    expect(latest[0].ts).toBe("2026-01-01T00:00:09Z");
    expect(aggregateAgentToolCalls(latest)).toHaveLength(0);
  });
});

describe("aggregateAgentToolCalls", () => {
  it("unions tool calls across channel and thread sessions", () => {
    const sessions: TrajectoryEvent[] = [
      completed({
        sessionKey: channel,
        ts: "2026-01-01T00:00:05Z",
        turns: [{ calls: [["c1", "read", { path: "~/.agents/skills/x/SKILL.md" }]] }],
      }),
      completed({
        sessionKey: thread,
        ts: "2026-01-01T00:00:09Z",
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
    expect(calls.find((c) => c.toolUseId === "t1")?.input).toEqual({
      path: "~/projects/nimbus/DEVELOPERS.md",
    });
    expect(calls.find((c) => c.toolUseId === "t1")?.result).toEqual({
      isError: false,
      content: "ok",
    });
  });

  it("dedupes a toolUseId seen in more than one session snapshot", () => {
    const sessions: TrajectoryEvent[] = [
      completed({ sessionKey: channel, ts: "t1", turns: [{ calls: [["dup", "read", {}]] }] }),
      completed({ sessionKey: thread, ts: "t2", turns: [{ calls: [["dup", "read", {}]] }] }),
    ];
    expect(aggregateAgentToolCalls(sessions)).toHaveLength(1);
  });

  it("skips a session whose snapshot is unusable but keeps the others", () => {
    const broken: TrajectoryEvent = {
      type: "model.completed",
      sessionKey: thread,
      ts: "t2",
      data: { messagesSnapshot: "truncated-garbage" },
    };
    const ok = completed({
      sessionKey: channel,
      ts: "t1",
      turns: [{ calls: [["c1", "exec", {}]] }],
    });
    expect(aggregateAgentToolCalls([ok, broken]).map((c) => c.toolUseId)).toEqual(["c1"]);
  });
});

describe("aggregateCost", () => {
  it("sums assistant cost and counts turns across sessions", () => {
    const sessions: TrajectoryEvent[] = [
      completed({ sessionKey: channel, ts: "t1", turns: [{ costTotal: 0.01 }] }),
      completed({
        sessionKey: thread,
        ts: "t2",
        turns: [{ costTotal: 0.02 }, { costTotal: 0.03 }],
      }),
    ];
    expect(aggregateCost(sessions)).toEqual({ cost: 0.06, turns: 3 });
  });

  it("counts only cost-bearing assistant turns", () => {
    const sessions = [completed({ sessionKey: channel, ts: "t1", turns: [{}] })];
    expect(aggregateCost(sessions)).toEqual({ cost: 0, turns: 0 });
  });
});
