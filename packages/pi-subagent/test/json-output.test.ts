import { describe, expect, it } from "vitest";
import { bounded, createJsonOutput, emptyUsage } from "../src/json-output.js";

const header = {
  type: "session",
  version: 3,
  id: "fixture-id",
  cwd: "/tmp",
  timestamp: "2026-06-01T00:00:00Z",
};

function answer(text = "final", stopReason = "stop", timestamp = 1) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      timestamp,
      provider: "fixture",
      model: "local",
      content: [{ type: "text", text }],
      stopReason,
      usage: { ...emptyUsage(), input: 2, output: 3, totalTokens: 5 },
    },
  };
}

function parse(events: unknown[]) {
  const parser = createJsonOutput();
  parser.feed(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n")));
  parser.end();
  return parser.assess();
}

describe("bounded Pi JSON output", () => {
  it("decodes every UTF-8 boundary and joins authoritative blocks, not snapshots", () => {
    const parser = createJsonOutput();
    const final = answer("日本語 😀\u2028\u2029");
    final.message.content.push({ type: "text", text: "second" });
    const bytes = Buffer.from(
      [
        header,
        { type: "message_update", usage: { input: 999 } },
        final,
        { type: "unknown-future-event" },
        { type: "agent_settled", aborted: false },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    for (const byte of bytes) parser.feed(Buffer.from([byte]));
    parser.end();
    expect(parser.assess()).toMatchObject({
      output: "日本語 😀\u2028\u2029\nsecond",
      error: undefined,
      truncated: false,
      usage: { input: 2, output: 3, totalTokens: 5 },
    });
  });

  it.each([
    [answer(), { type: "agent_settled", aborted: false }],
    [header, answer()],
    [header, answer(), { type: "agent_end", willRetry: false }],
    [header, answer(), { type: "agent_settled", aborted: true }],
    [header, answer("failure", "error"), { type: "agent_settled", aborted: false }],
    [header, answer("partial", "length"), { type: "agent_settled", aborted: false }],
    [header, answer(), { type: "turn_start" }, { type: "agent_settled", aborted: false }],
    [
      header,
      { type: "message_end", message: { role: "assistant", content: "bad" } },
      answer(),
      { type: "agent_settled", aborted: false },
    ],
    [header, answer(), { type: "agent_settled", aborted: "false" }],
  ])("rejects incomplete or invalid settlement %#", (...events) => {
    expect(parse(events).error).toBeDefined();
  });

  it("recovers intermediate provider errors but never malformed protocol", () => {
    const result = parse([
      header,
      answer("error", "error"),
      { type: "auto_retry_end", success: false, finalError: "temporary" },
      { type: "agent_start" },
      answer("recovered", "stop", 2),
      { type: "agent_settled", aborted: false },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("recovered");
    expect(result.usage.totalTokens).toBe(10);
    const parser = createJsonOutput();
    parser.feed(Buffer.from(`${JSON.stringify(header)}\n{bad}\n${JSON.stringify(answer())}\n`));
    parser.end();
    expect(parser.assess().error).toContain("Invalid Pi JSON stream");
  });

  it("counts finalized assistant and nested tool usage once, not tool/turn snapshots", () => {
    const final = answer();
    const tool = {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "one", usage: final.message.usage },
    };
    const result = parse([
      header,
      { type: "message_update", usage: final.message.usage },
      final,
      final,
      { type: "turn_end", message: final.message },
      { type: "tool_execution_end", result: { usage: final.message.usage } },
      tool,
      tool,
      { type: "agent_settled", aborted: false },
    ]);
    expect(result.usage.totalTokens).toBe(10);
  });

  it("preserves optional usage without adding reasoning to total tokens again", () => {
    const message = {
      ...answer().message,
      usage: { ...answer().message.usage, cacheWrite1h: 1, reasoning: 2 },
    };
    const result = parse([
      header,
      { type: "message_end", message },
      { type: "message_end", message },
      { type: "agent_settled", aborted: false },
    ]);
    expect(result.usage).toMatchObject({
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 5,
      output: 3,
    });
  });

  it("does not collapse distinct finalized responses with the same model timestamp", () => {
    const final = answer();
    const result = parse([
      header,
      final,
      { type: "turn_start" },
      final,
      { type: "agent_settled", aborted: false },
    ]);
    expect(result.usage.totalTokens).toBe(10);
  });

  it("bounds final text without changing successful stop semantics", () => {
    const result = parse([
      header,
      answer("😀".repeat(20_000)),
      { type: "agent_settled", aborted: false },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(48 * 1024);
    expect(result.output).not.toContain("�");
  });

  it("fails oversized records and keeps pending storage bounded", () => {
    const parser = createJsonOutput();
    parser.feed(Buffer.from(`${JSON.stringify(header)}\n`));
    parser.feed(Buffer.alloc(1024 * 1024 + 1, 65));
    expect(parser.protocolError).toContain("exceeds");
    for (let count = 0; count < 10; ++count) parser.feed(Buffer.alloc(1024 * 1024));
    parser.end();
    expect(parser.assess().error).toContain("exceeds");
  });

  it("truncates on byte boundaries even with tiny budgets", () => {
    for (let bytes = 0; bytes < 100; ++bytes) {
      const value = bounded("😀".repeat(100), bytes);
      expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(bytes);
      expect(value.text).not.toContain("�");
      expect(value.truncated).toBe(true);
    }
  });
});
