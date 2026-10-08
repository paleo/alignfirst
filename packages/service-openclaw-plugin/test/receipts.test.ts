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

const DISCORD_THREAD_CREATE = {
  toolName: "message",
  params: {
    action: "thread-create",
    to: "channel:C1",
    messageId: "anchor-1",
    threadName: "Work",
  },
  result: { details: { ok: true, thread: { id: "T1", parent_id: "C1" } } },
};
const DISCORD_STARTER_REPLY = {
  toolName: "message",
  toolCallId: "call-2",
  params: { action: "thread-reply", threadId: "T1", message: STARTER },
  result: { details: { ok: true, result: { messageId: "M2", channelId: "T1" } } },
};
const DISCORD_REPLY_REJECTIONS: Array<{
  params?: Record<string, unknown>;
  details?: unknown;
  reason: string;
}> = [
  { params: { threadId: "T-OTHER" }, reason: "unknownThread" },
  { params: { threadId: undefined }, reason: "missingThread" },
  { params: { message: " " }, reason: "missingStarter" },
  { details: { ok: false }, reason: "notSent" },
  { details: { ok: true, partial: true }, reason: "partialDelivery" },
  {
    details: { ok: true, result: { messageId: "M2", channelId: "T-OTHER" } },
    reason: "threadMismatch",
  },
  { params: { accountId: "other-account" }, reason: "accountMismatch" },
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

  it("accepts a Discord starter reply into a thread the session created", async () => {
    const fixture = coordinator("discord");
    observe(fixture, DISCORD_THREAD_CREATE);
    observe(fixture, DISCORD_STARTER_REPLY);
    await expect(lookup(fixture, "T1")).resolves.toMatchObject({
      threadId: "T1",
      starterText: STARTER,
      starterMessageId: "M2",
    });
    expect(fixture.logger.debug).not.toHaveBeenCalled();
  });

  it("reads the Discord reply thread from the target when threadId is absent", async () => {
    const fixture = coordinator("discord");
    observe(fixture, DISCORD_THREAD_CREATE);
    observe(fixture, {
      ...DISCORD_STARTER_REPLY,
      params: { action: "thread-reply", to: "channel:T1", message: STARTER },
    });
    await expect(lookup(fixture, "T1")).resolves.toMatchObject({ threadId: "T1" });
    expect(fixture.logger.debug).not.toHaveBeenCalled();
  });

  it("does not take a Discord thread creation with content as a receipt", async () => {
    const fixture = coordinator("discord");
    observe(fixture, {
      ...DISCORD_THREAD_CREATE,
      params: { ...DISCORD_THREAD_CREATE.params, message: STARTER },
    });
    await expect(lookup(fixture, "T1")).resolves.toBeUndefined();
  });

  it("forgets a partial Discord thread creation", async () => {
    const fixture = coordinator("discord");
    observe(fixture, {
      ...DISCORD_THREAD_CREATE,
      result: { details: { ok: true, partial: true, thread: { id: "T1", parent_id: "C1" } } },
    });
    observe(fixture, DISCORD_STARTER_REPLY);
    await expect(lookup(fixture, "T1")).resolves.toBeUndefined();
    expect(reasons(fixture)).toEqual(["partialDelivery", "unknownThread"]);
  });

  it.each(DISCORD_REPLY_REJECTIONS)(
    "rejects a Discord starter reply with reason=$reason",
    async (rejection) => {
      const fixture = coordinator("discord");
      observe(fixture, DISCORD_THREAD_CREATE);
      observe(fixture, {
        ...DISCORD_STARTER_REPLY,
        params: { ...DISCORD_STARTER_REPLY.params, ...rejection.params },
        result: { details: rejection.details ?? DISCORD_STARTER_REPLY.result.details },
      });
      await expect(lookup(fixture, "T1")).resolves.toBeUndefined();
      expect(reasons(fixture)).toEqual([rejection.reason]);
      expect(fixture.logger.debug.mock.calls[0]?.[0]).not.toContain(STARTER);
    },
  );

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

function observe(
  fixture: ReturnType<typeof coordinator>,
  observation: Parameters<ReturnType<typeof coordinator>["receipts"]["observe"]>[0],
) {
  fixture.receipts.observe(observation, {
    sessionKey: fixture.context.sessionKey,
    sessionId: fixture.context.sessionId,
  });
}

function reasons(fixture: ReturnType<typeof coordinator>): string[] {
  return fixture.logger.debug.mock.calls.map(
    (call) => /reason=(\w+)/u.exec(String(call[0]))?.[1] ?? "-",
  );
}

function lookup(fixture: ReturnType<typeof coordinator>, threadId: string) {
  return fixture.receipts.waitForReceipt({
    sourceSessionKey: fixture.context.sessionKey ?? "",
    sourceSessionId: fixture.context.sessionId ?? "",
    threadId,
  });
}
