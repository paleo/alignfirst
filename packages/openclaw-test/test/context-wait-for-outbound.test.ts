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

function makeOutboundEntry(id: string, seq: number, text: string): OutboundReceivedEntry {
  return {
    seq,
    ts: new Date().toISOString(),
    kind: "outboundReceived",
    messageId: id,
    text,
  };
}

function makeCliMockEntry(cli: string, argv: string[]): CliMockEntry {
  return {
    seq: 0,
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

  it("throws on cliMock-grace expiry", async () => {
    const cliMockEntry = makeCliMockEntry("claude", ["Run the _AAD_ protocol"]);
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => ({ atMs: 1000, entry: cliMockEntry }),
    };
    let now = 1000;
    let polls = 0;
    await expect(
      waitForOutbound(deps, () => false, {
        sinceCursor: 0,
        failFastCliMockGraceMs: 10_000,
        nowImpl: () => now,
        pollImpl: async () => {
          polls += 1;
          now += 11_000;
          return { messages: [], nextCursor: 1 };
        },
      }),
    ).rejects.toThrow(
      /invoked a mocked CLI and did not produce a matching outbound within 10000ms/,
    );
    expect(polls).toBeGreaterThan(0);
  });

  it("cliMock-grace resets when a fresh cliMock is observed", async () => {
    let now = 1000;
    let lastCliMockAt = 1000;
    const cliMockEntry = makeCliMockEntry("claude", ["foo"]);
    const deps: WaitForOutboundDeps = {
      accountId: "ch",
      awaitEntry: async (id) => makeOutboundEntry(id, 1, ""),
      getLastCliMock: () => ({ atMs: lastCliMockAt, entry: cliMockEntry }),
    };
    let pollIdx = 0;
    const result = waitForOutbound(deps, (m) => m.text === "DONE", {
      sinceCursor: 0,
      timeoutMs: 60_000,
      failFastCliMockGraceMs: 10_000,
      nowImpl: () => now,
      pollImpl: async () => {
        pollIdx += 1;
        if (pollIdx === 1) {
          // ~5s into the wait — reset the cliMock timer.
          now += 5_000;
          lastCliMockAt = now;
          return { messages: [], nextCursor: 1 };
        }
        if (pollIdx === 2) {
          now += 5_000;
          return { messages: [makeMessage("a", "DONE")], nextCursor: 2 };
        }
        return { messages: [], nextCursor: 99 };
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
