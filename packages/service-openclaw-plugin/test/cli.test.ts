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
  });
});

describe("thread-handoff receipt rendering", () => {
  it("renders an empty JSON array", () => {
    expect(JSON.parse(renderReceipts([], true))).toEqual([]);
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
  });

  it("omits private starter text from human-readable output", () => {
    const records = [
      receipt(),
      receipt({ receiptKey: "receipt-2", threadId: "200.300", starterMessageId: undefined }),
    ];
    const output = renderReceipts(records, false);
    for (const record of records) expect(output).not.toContain(record.starterText);
  });
});
