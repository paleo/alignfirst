import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createReceiptCoordinator } from "../src/thread-handoff/receipts.js";
import { createHandoffStore } from "../src/thread-handoff/state.js";
import { temporaryStateDir } from "./helpers.js";

const PRODUCTION_SLACK_RESULT = {
  channel: "slack",
  to: "C0BJ7KLRXEZ",
  via: "direct",
  result: {
    target: { kind: "channel", id: "C0BJ7KLRXEZ" },
    messageId: "1788946879.083059",
    receipt: { threadId: "1788946859.060069" },
  },
  deliveryStatus: "sent",
  messageDelivery: { status: "settled", partialDelivery: false },
};
const STARTER = "private starter text";
const SLACK_REJECTIONS: Array<{ details: unknown; reason: string }> = [
  {
    details: { ...PRODUCTION_SLACK_RESULT, deliveryStatus: "partial_failed" },
    reason: "notSent",
  },
  {
    details: {
      ...PRODUCTION_SLACK_RESULT,
      messageDelivery: { status: "settled", partialDelivery: true },
    },
    reason: "partialDelivery",
  },
  {
    details: {
      ...PRODUCTION_SLACK_RESULT,
      result: {
        ...PRODUCTION_SLACK_RESULT.result,
        target: { kind: "channel", id: "C-OTHER" },
      },
    },
    reason: "channelMismatch",
  },
  {
    details: {
      ...PRODUCTION_SLACK_RESULT,
      result: {
        ...PRODUCTION_SLACK_RESULT.result,
        receipt: { threadId: "different-thread" },
      },
    },
    reason: "threadMismatch",
  },
  {
    details: {
      ok: true,
      result: { channelId: "C0BJ7KLRXEZ", messageId: "1788946879.083059" },
    },
    reason: "unsupportedResultShape",
  },
  {
    details: {
      ...PRODUCTION_SLACK_RESULT,
      result: { ...PRODUCTION_SLACK_RESULT.result, target: { kind: "channel" } },
    },
    reason: "unsupportedResultShape",
  },
];

describe("native delivery receipts", () => {
  it("accepts the production Slack result and preserves exact starter text", async () => {
    const fixture = coordinator("slack", undefined, "C0BJ7KLRXEZ");
    fixture.receipts.observe(
      {
        toolName: "message",
        toolCallId: "call-1",
        params: {
          action: "send",
          to: "channel:C0BJ7KLRXEZ",
          threadId: "1788946859.060069",
          message: "  exact  ",
        },
        result: { details: PRODUCTION_SLACK_RESULT },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    await expect(lookup(fixture, "1788946859.060069")).resolves.toMatchObject({
      starterText: "  exact  ",
      starterMessageId: "1788946879.083059",
    });
  });

  it.each(SLACK_REJECTIONS)("rejects Slack delivery with reason=$reason", async (rejection) => {
    const fixture = coordinator("slack", undefined, "C0BJ7KLRXEZ");
    fixture.receipts.observe(
      {
        toolName: "message",
        params: {
          action: "send",
          to: "channel:C0BJ7KLRXEZ",
          threadId: "1788946859.060069",
          message: STARTER,
        },
        result: { details: rejection.details },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    await expect(lookup(fixture, "1788946859.060069")).resolves.toBeUndefined();
    expect(fixture.logger.debug).toHaveBeenCalledTimes(1);
    const diagnostic = fixture.logger.debug.mock.calls[0]?.[0];
    expect(diagnostic).toContain(`reason=${rejection.reason}`);
    expect(diagnostic).not.toContain(STARTER);
  });

  it("rejects partial Discord creation and accepts a complete anchored result", async () => {
    const fixture = coordinator("discord");
    const observation = {
      toolName: "message",
      params: {
        action: "thread-create",
        to: "channel:C1",
        messageId: "anchor-1",
        message: "starter",
      },
      result: { details: { ok: true, partial: true, thread: { id: "T1", parent_id: "C1" } } },
    };
    fixture.receipts.observe(observation, {
      sessionKey: fixture.context.sessionKey,
      sessionId: fixture.context.sessionId,
    });
    fixture.receipts.observe(
      {
        ...observation,
        result: { details: { ok: true, thread: { id: "T1", parent_id: "C1" } } },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    const stored = await lookup(fixture, "T1");
    expect(stored).toMatchObject({ threadId: "T1" });
    expect(stored).not.toHaveProperty("starterMessageId");
  });

  it("exposes receipt write failures", async () => {
    const fixture = coordinator(
      "slack",
      () => {
        throw new Error("disk unavailable");
      },
      "C0BJ7KLRXEZ",
    );
    fixture.receipts.observe(
      {
        toolName: "message",
        params: {
          action: "send",
          to: "channel:C0BJ7KLRXEZ",
          threadId: "1788946859.060069",
          message: "starter",
        },
        result: { details: PRODUCTION_SLACK_RESULT },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    await expect(lookup(fixture, "1788946859.060069")).rejects.toThrow("disk unavailable");
    expect(fixture.logger.error).toHaveBeenCalled();
  });
});

function coordinator(
  surface: "slack" | "discord",
  insertReceipt?: () => void,
  conversationId = "C1",
) {
  const store = createHandoffStore(temporaryStateDir());
  if (insertReceipt) store.insertReceipt = insertReceipt;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let currentTime = 0;
  const context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionKey: `agent:main:${surface}:channel:${conversationId}`,
    sessionId: "source-uuid",
    messageChannel: surface,
    nativeChannelId: conversationId,
  };
  const receipts = createReceiptCoordinator({
    configuration: { channelSurfaces: { [surface]: surface } },
    getStore: () => store,
    logger: logger as unknown as PluginLogger,
    now: () => {
      currentTime += 1_000;
      return currentTime;
    },
  });
  receipts.captureContext(context);
  return { receipts, context, logger };
}

function lookup(fixture: ReturnType<typeof coordinator>, threadId: string) {
  return fixture.receipts.waitForReceipt({
    sourceSessionKey: fixture.context.sessionKey ?? "",
    sourceSessionId: fixture.context.sessionId ?? "",
    threadId,
  });
}
