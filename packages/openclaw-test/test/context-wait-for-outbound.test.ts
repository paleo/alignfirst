import { describe, expect, it } from "vitest";
import {
  type BusMessage,
  type PollResult,
  waitForOutbound,
  type WaitForOutboundDeps,
} from "../src/context.js";
import type { CliMockEntry, OutboundReceivedEntry } from "../src/report.js";

function makeMessage(id: string, text: string, threadId?: string): BusMessage {
  return {
    id,
    text,
    threadId,
    conversation: { kind: "channel", id: "conv", title: "conv" },
    sender: { id: "agent", name: "agent" },
    ts: new Date().toISOString(),
  } as unknown as BusMessage;
}

function makeOutboundEntry(id: string, entrySeq: number, text: string): OutboundReceivedEntry {
  return {
    entrySeq,
    ts: new Date().toISOString(),
    kind: "outboundReceived",
    messageId: id,
    text,
  };
}

function makeCliMockEntry(cli: string, argv: string[], entrySeq = 0): CliMockEntry {
  return {
    entrySeq,
    ts: new Date().toISOString(),
    kind: "cliMock",
    call: {
      cli,
      argv,
      cwd: "/",
      stdin: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
  };
}

describe("waitForOutbound fail-fast", () => {
  it("returns the match when a batch contains matching + non-matching", async () => {
    const polls: PollResult[] = [
      {
        messages: [makeMessage("a", "nope"), makeMessage("b", "DONE")],
        nextCursor: 1,
      },
    ];
    let idx = 0;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 7, id === "b" ? "DONE" : "nope"),
      getLastCliMock: () => undefined,
    };
    const result = await waitForOutbound(deps, (m) => m.text === "DONE", {
      sinceCursor: 0,
      pollImpl: async () => polls[idx++] ?? { messages: [], nextCursor: 1 },
    });
    expect(result.match.id).toBe("b");
  });

  it("throws after failFastUnmatchedOutbounds reached", async () => {
    const polls: PollResult[] = [
      { messages: [makeMessage("a", "Working on it")], nextCursor: 1 },
      { messages: [makeMessage("b", "Still working")], nextCursor: 2 },
      { messages: [makeMessage("c", "Almost done")], nextCursor: 3 },
    ];
    let idx = 0;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 9, "Almost done"),
      getLastCliMock: () => undefined,
    };
    await expect(
      waitForOutbound(deps, (m) => m.text.includes("DONE"), {
        sinceCursor: 0,
        pollImpl: async () => polls[idx++] ?? { messages: [], nextCursor: 99 },
      }),
    ).rejects.toThrow(/posted 3 outbounds but none matched/);
  });

  it("throws when an in-wait cliMock goes quiet past the grace", async () => {
    let now = 1000;
    let last: { atMs: number; entry: CliMockEntry } | undefined;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => last,
    };
    await expect(
      waitForOutbound(deps, () => false, {
        sinceCursor: 0,
        timeoutMs: 60_000,
        failFastCliMockGraceMs: 10_000,
        nowImpl: () => now,
        pollImpl: async () => {
          last ??= { atMs: now, entry: makeCliMockEntry("claude", ["Run the _AAD_ protocol"], 1) };
          now += 11_000;
          return { messages: [], nextCursor: 1 };
        },
      }),
    ).rejects.toThrow(/invoked a mocked CLI during this wait and posted no outbound for 10000ms/);
  });

  it("ignores a cliMock from before the wait started", async () => {
    // Regression: a completed channel-phase CLI call must not trip a later wait.
    const stale = { atMs: 1000, entry: makeCliMockEntry("alcode", ["projects", "list"]) };
    let now = 60_000;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => stale,
    };
    await expect(
      waitForOutbound(deps, () => false, {
        sinceCursor: 0,
        timeoutMs: 20_000,
        failFastCliMockGraceMs: 10_000,
        nowImpl: () => now,
        pollImpl: async () => {
          now += 6_000;
          return { messages: [], nextCursor: 1 };
        },
      }),
    ).rejects.toThrow(/timed out after 20000ms/);
  });

  it("an outbound after the cliMock disarms the grace", async () => {
    let now = 1000;
    let last: { atMs: number; entry: CliMockEntry } | undefined;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => last,
    };
    let pollIdx = 0;
    await expect(
      waitForOutbound(deps, (m) => m.text === "DONE", {
        sinceCursor: 0,
        timeoutMs: 30_000,
        failFastCliMockGraceMs: 10_000,
        failFastUnmatchedOutbounds: false,
        nowImpl: () => now,
        pollImpl: async () => {
          ++pollIdx;
          if (pollIdx === 1) {
            last = { atMs: now, entry: makeCliMockEntry("claude", ["work"], 1) };
            now += 5_000;
            return { messages: [], nextCursor: 1 };
          }
          if (pollIdx === 2) {
            now += 1_000;
            return { messages: [makeMessage("n1", "planning note")], nextCursor: 2 };
          }
          now += 8_000;
          return { messages: [], nextCursor: 99 };
        },
      }),
    ).rejects.toThrow(/timed out after 30000ms/);
  });

  it("re-arms on the next cliMock after a disarming outbound", async () => {
    let now = 1000;
    let last: { atMs: number; entry: CliMockEntry } | undefined;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => last,
    };
    let pollIdx = 0;
    await expect(
      waitForOutbound(deps, (m) => m.text === "DONE", {
        sinceCursor: 0,
        timeoutMs: 60_000,
        failFastCliMockGraceMs: 10_000,
        failFastUnmatchedOutbounds: false,
        nowImpl: () => now,
        pollImpl: async () => {
          ++pollIdx;
          if (pollIdx === 1) {
            last = { atMs: now, entry: makeCliMockEntry("claude", ["a"], 1) };
            now += 2_000;
            return { messages: [], nextCursor: 1 };
          }
          if (pollIdx === 2) {
            now += 1_000;
            return { messages: [makeMessage("n1", "planning note")], nextCursor: 2 };
          }
          if (pollIdx === 3) {
            now += 1_000;
            last = { atMs: now, entry: makeCliMockEntry("codex", ["b"], 2) };
            now += 11_000;
            return { messages: [], nextCursor: 3 };
          }
          now += 5_000;
          return { messages: [], nextCursor: 99 };
        },
      }),
    ).rejects.toThrow(/invoked a mocked CLI during this wait and posted no outbound for 10000ms/);
  });

  it("a fresh cliMock resets the grace timer", async () => {
    let now = 1000;
    let last: { atMs: number; entry: CliMockEntry } | undefined;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => last,
    };
    let pollIdx = 0;
    const result = waitForOutbound(deps, (m) => m.text === "DONE", {
      sinceCursor: 0,
      timeoutMs: 60_000,
      failFastCliMockGraceMs: 10_000,
      nowImpl: () => now,
      pollImpl: async () => {
        ++pollIdx;
        if (pollIdx === 1) {
          last = { atMs: now, entry: makeCliMockEntry("claude", ["a"], 1) };
          now += 8_000;
          return { messages: [], nextCursor: 1 };
        }
        if (pollIdx === 2) {
          last = { atMs: now, entry: makeCliMockEntry("claude", ["b"], 2) };
          now += 8_000;
          return { messages: [], nextCursor: 2 };
        }
        return { messages: [makeMessage("a", "DONE")], nextCursor: 3 };
      },
    });
    await expect(result).resolves.toMatchObject({ match: { id: "a" } });
  });

  it("plain timeout when nothing happens", async () => {
    let now = 1000;
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => undefined,
    };
    await expect(
      waitForOutbound(deps, () => false, {
        sinceCursor: 0,
        timeoutMs: 1000,
        nowImpl: () => now,
        pollImpl: async () => {
          now += 600;
          return { messages: [], nextCursor: 1 };
        },
      }),
    ).rejects.toThrow(/timed out after 1000ms/);
  });
});
