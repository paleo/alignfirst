import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptCoordinator } from "../src/receipts.js";
import { createHandoffService } from "../src/service.js";
import { createHandoffStore } from "../src/state.js";
import { createThreadHandoffTool } from "../src/tool.js";
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
    expect(fixture.enqueue).toHaveBeenCalledTimes(2);
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

  it("claims only from the trusted target session and reports repeated claims", async () => {
    const fixture = toolFixture();
    fixture.store.insertHandoff(handoff());
    const target = toolFixture(
      null,
      {
        sessionKey: handoff().targetSessionKey,
        nativeChannelId: "C1",
      },
      fixture.store,
    );
    await expect(
      target.tool.execute("claim-1", { action: "claim", handoffId: "handoff-1" }),
    ).resolves.toMatchObject({ details: { status: "claimed" } });
    await expect(
      target.tool.execute("claim-2", { action: "claim", handoffId: "handoff-1" }),
    ).resolves.toMatchObject({ details: { status: "alreadyClaimed" } });
    await expect(
      fixture.tool.execute("wrong", { action: "claim", handoffId: "handoff-1" }),
    ).rejects.toThrow(/invalidTarget/);
    fixture.store.close();
  });
});

function toolFixture(
  availableReceipt: ReturnType<typeof receipt> | null = receipt(),
  contextOverrides: Partial<OpenClawPluginToolContext> = {},
  providedStore?: ReturnType<typeof createHandoffStore>,
) {
  const store = providedStore ?? createHandoffStore(temporaryStateDir());
  const waitForReceipt = vi.fn().mockResolvedValue(availableReceipt);
  const receipts = {
    captureContext: vi.fn(),
    observe: vi.fn(),
    waitForReceipt,
  } as unknown as ReceiptCoordinator;
  const enqueue = vi.fn(() => true);
  const runtime = {
    system: { enqueueSystemEvent: enqueue, requestHeartbeat: vi.fn() },
  } as unknown as OpenClawPluginApi["runtime"];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as PluginLogger;
  const context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C1",
    sessionId: "source-uuid",
    messageChannel: "slack",
    agentAccountId: "workspace-1",
    nativeChannelId: "C1",
    ...contextOverrides,
  };
  const service = createHandoffService({ runtime, getStore: () => store, logger });
  return {
    store,
    enqueue,
    waitForReceipt,
    tool: createThreadHandoffTool({
      context,
      configuration: { channelSurfaces: { slack: "slack" } },
      receipts,
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
