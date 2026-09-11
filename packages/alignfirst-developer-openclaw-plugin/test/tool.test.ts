import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptCoordinator } from "../src/thread-handoff/receipts.js";
import { createRunIdCache } from "../src/thread-handoff/run-ids.js";
import type { HandoffService } from "../src/thread-handoff/service.js";
import { createHandoffStore, type HandoffStore } from "../src/thread-handoff/state.js";
import { createThreadHandoffTool } from "../src/thread-handoff/tool.js";
import type { DeliveryReceipt, HandoffRecord } from "../src/thread-handoff/types.js";
import { handoff, receipt, temporaryStateDir } from "./helpers.js";

describe("thread_handoff tool", () => {
  it("starts once and remains idempotent after the receipt disappears", async () => {
    const fixture = toolFixture();
    const first = await fixture.tool.execute("call-1", { action: "start", threadId: "100.200" });
    expect(first.details).toMatchObject({
      status: "queued",
      sessionKey: "agent:main:slack:channel:C1:thread:100.200",
    });
    fixture.waitForReceipt.mockResolvedValue(undefined);
    const second = await fixture.tool.execute("call-2", { action: "start", threadId: "100.200" });
    expect(second.details).toMatchObject({
      status: "alreadyStarted",
      handoffId: first.details && readString(first.details, "handoffId"),
    });
    expect(fixture.startTurn).toHaveBeenCalledTimes(1);
    fixture.store.close();
  });

  it("retries a duplicate start whose first attempt never started", async () => {
    const fixture = toolFixture();
    const pending = handoff({
      routeKey: '["main","slack","workspace-1","agent:main:slack:channel:C1:thread:100.200"]',
      handoffId: "retry-handoff",
      sessionKey: "agent:main:slack:channel:C1",
      sessionId: "source-uuid",
      channelId: "slack",
      accountId: "workspace-1",
      parentConversationId: "C1",
      threadId: "100.200",
      targetSessionKey: "agent:main:slack:channel:C1:thread:100.200",
    });
    fixture.store.insertHandoff(pending);

    await expect(
      fixture.tool.execute("retry", { action: "start", threadId: "100.200" }),
    ).resolves.toMatchObject({ details: { status: "alreadyStarted" } });
    expect(fixture.startTurn).toHaveBeenCalledTimes(1);
    fixture.store.close();
  });

  it("rejects unverified starts and unrelated properties", async () => {
    const fixture = toolFixture(null);
    await expect(
      fixture.tool.execute("call-1", { action: "start", threadId: "100.200" }),
    ).rejects.toThrow(/unverifiedThreadDelivery/);
    await expect(
      fixture.tool.execute("call-2", { action: "claim", handoffId: "x", sessionKey: "forged" }),
    ).rejects.toThrow(/invalidTarget/);
    fixture.store.close();
  });

  it("claims idempotently in one run and reports another run with claimedAt", async () => {
    const fixture = toolFixture();
    fixture.store.insertHandoff(handoff());
    const target = toolFixture(
      null,
      {
        sessionKey: handoff().targetSessionKey,
        nativeChannelId: "C1",
      },
      fixture.store,
      "run-1",
    );
    await expect(
      target.tool.execute("claim-1", { action: "claim", handoffId: "handoff-1" }),
    ).resolves.toMatchObject({ details: { status: "claimed" } });
    await expect(
      target.tool.execute("claim-2", { action: "claim", handoffId: "handoff-1" }),
    ).resolves.toMatchObject({ details: { status: "claimed" } });
    const otherRun = toolFixture(
      null,
      { sessionKey: handoff().targetSessionKey, nativeChannelId: "C1" },
      fixture.store,
      "run-2",
    );
    await expect(
      otherRun.tool.execute("claim-3", { action: "claim", handoffId: "handoff-1" }),
    ).resolves.toMatchObject({
      details: { status: "alreadyClaimed", claimedAt: expect.any(Number) },
    });
    await expect(
      fixture.tool.execute("wrong", { action: "claim", handoffId: "handoff-1" }),
    ).rejects.toThrow(/invalidTarget/);
    fixture.store.close();
  });
});

function toolFixture(
  availableReceipt: DeliveryReceipt | null = receipt(),
  contextOverrides: Partial<OpenClawPluginToolContext> = {},
  providedStore?: HandoffStore,
  runId = "run-1",
) {
  const store = providedStore ?? createHandoffStore(temporaryStateDir());
  const waitForReceipt = vi.fn().mockResolvedValue(availableReceipt);
  const receipts = {
    captureContext: vi.fn(),
    observe: vi.fn(),
    waitForReceipt,
  } as unknown as ReceiptCoordinator;
  const startTurn = vi.fn(async (record: HandoffRecord) => {
    store.recordAttempt(record.routeKey, Date.now());
  });
  const service: HandoffService = {
    startTurn,
    runForTarget: async (_targetSessionKey, operation) => operation(),
    start: async () => undefined,
    stop: async () => undefined,
  };
  const context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C1",
    sessionId: "source-uuid",
    messageChannel: "slack",
    agentAccountId: "workspace-1",
    nativeChannelId: "C1",
    ...contextOverrides,
  };
  const runIds = createRunIdCache();
  runIds.remember({ sessionKey: context.sessionKey, sessionId: context.sessionId, runId });
  return {
    store,
    startTurn,
    waitForReceipt,
    tool: createThreadHandoffTool({
      context,
      configuration: { channelSurfaces: { slack: "slack" } },
      receipts,
      runIds,
      getStore: () => store,
      service,
    }),
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return;
  const found = Reflect.get(value, key);
  return typeof found === "string" ? found : undefined;
}
