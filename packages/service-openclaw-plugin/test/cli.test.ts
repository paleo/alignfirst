import { describe, expect, it } from "vitest";
import { renderHandoffs, renderReceipts } from "../src/thread-handoff/cli.js";
import { handoff, receipt } from "./helpers.js";

describe("thread-handoff list rendering", () => {
  it("renders JSON without starter text while preserving handoff metadata", () => {
    const record = handoff({
      starterText: "private starter text",
      state: "claimed",
      claimedAt: 2_000,
      claimedBy: { sessionId: "target-uuid", runId: "run-1" },
    });
    const output = renderHandoffs([record], true);
    const { starterText, ...metadata } = record;
    expect(JSON.parse(output)).toEqual([metadata]);
    expect(output).not.toContain(starterText);
    expect(record.starterText).toBe(starterText);
    expect(JSON.parse(output)[0].claimedBy).toEqual({
      sessionId: "target-uuid",
      runId: "run-1",
    });
  });

  it("renders attempt counts in text output", () => {
    expect(renderHandoffs([handoff({ attemptCount: 3 })], false)).toContain("3 attempts");
  });
});

describe("thread-handoff receipt rendering", () => {
  it("renders empty JSON and text output", () => {
    expect(renderReceipts([], true)).toBe("[]");
    expect(renderReceipts([], false)).toBe("No active receipts.");
  });

  it("renders JSON without starter text", () => {
    const output = renderReceipts(
      [
        receipt(),
        receipt({
          receiptKey: "receipt-2",
          threadId: "200.300",
          starterMessageId: undefined,
        }),
      ],
      true,
    );
    expect(JSON.parse(output)).toEqual([
      {
        sessionKey: receipt().sessionKey,
        sessionId: receipt().sessionId,
        threadId: receipt().threadId,
        starterMessageId: receipt().starterMessageId,
        createdAt: receipt().createdAt,
        expiresAt: receipt().expiresAt,
      },
      {
        sessionKey: receipt().sessionKey,
        sessionId: receipt().sessionId,
        threadId: "200.300",
        createdAt: receipt().createdAt,
        expiresAt: receipt().expiresAt,
      },
    ]);
    expect(output).not.toContain(receipt().starterText);
  });

  it("renders tab-separated text without starter text", () => {
    const records = [
      receipt(),
      receipt({ receiptKey: "receipt-2", threadId: "200.300", starterMessageId: undefined }),
    ];
    const output = renderReceipts(records, false);
    expect(output).toBe(
      `${records[0].sessionKey}\t100.200\t100.201\t1000\t3601000\n${records[1].sessionKey}\t200.300\t-\t1000\t3601000`,
    );
    expect(output).not.toContain(receipt().starterText);
  });
});
