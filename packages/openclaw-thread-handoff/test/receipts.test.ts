import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createReceiptCoordinator } from "../src/receipts.js";
import { createHandoffStore } from "../src/state.js";
import { temporaryStateDir } from "./helpers.js";

describe("native delivery receipts", () => {
  it("accepts confirmed Slack sends and preserves exact starter text", async () => {
    const fixture = coordinator("slack");
    fixture.receipts.observe(
      {
        toolName: "message",
        toolCallId: "call-1",
        params: { action: "send", to: "channel:C1", threadId: "100.200", message: "  exact  " },
        result: { details: { ok: true, result: { channelId: "C1", messageId: "100.201" } } },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    await expect(
      fixture.receipts.waitForReceipt({
        sourceSessionKey: fixture.context.sessionKey ?? "",
        sourceSessionId: fixture.context.sessionId ?? "",
        threadId: "100.200",
      }),
    ).resolves.toMatchObject({ starterText: "  exact  ", starterMessageId: "100.201" });
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
    const wait = lookup(fixture, "T1");
    setTimeout(() => {
      fixture.receipts.observe(
        {
          ...observation,
          result: { details: { ok: true, thread: { id: "T1", parent_id: "C1" } } },
        },
        { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
      );
    }, 30);
    const stored = await wait;
    expect(stored).toMatchObject({ threadId: "T1" });
    expect(stored).not.toHaveProperty("starterMessageId");
  });

  it("rejects unrelated destinations and exposes receipt write failures", async () => {
    const fixture = coordinator("slack", () => {
      throw new Error("disk unavailable");
    });
    fixture.receipts.observe(
      {
        toolName: "message",
        params: { action: "send", to: "channel:C1", threadId: "T1", message: "starter" },
        result: { details: { ok: true, result: { channelId: "C1", messageId: "M1" } } },
      },
      { sessionKey: fixture.context.sessionKey, sessionId: fixture.context.sessionId },
    );
    await expect(lookup(fixture, "T1")).rejects.toThrow("disk unavailable");
    expect(fixture.logger.error).toHaveBeenCalled();
  });
});

function coordinator(surface: "slack" | "discord", insertReceipt?: () => void) {
  const store = createHandoffStore(temporaryStateDir());
  if (insertReceipt) store.insertReceipt = insertReceipt;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionKey: `agent:main:${surface}:channel:C1`,
    sessionId: "source-uuid",
    messageChannel: surface,
    nativeChannelId: "C1",
  };
  const receipts = createReceiptCoordinator({
    configuration: { channelSurfaces: { [surface]: surface } },
    getStore: () => store,
    logger: logger as unknown as PluginLogger,
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
