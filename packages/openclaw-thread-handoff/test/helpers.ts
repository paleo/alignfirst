import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryReceipt, HandoffRecord } from "../src/types.js";

export function temporaryStateDir(): string {
  return mkdtempSync(join(tmpdir(), "thread-handoff-test-"));
}

export function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    schemaVersion: 1,
    receiptKey: "receipt-1",
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C1",
    sessionId: "source-uuid",
    channelId: "slack",
    accountId: "workspace-1",
    parentConversationId: "C1",
    threadId: "100.200",
    starterMessageId: "100.201",
    starterText: "Please do the work.",
    toolCallId: "tool-1",
    createdAt: 1_000,
    expiresAt: 3_601_000,
    ...overrides,
  };
}

export function handoff(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    schemaVersion: 1,
    routeKey: "route-1",
    handoffId: "handoff-1",
    targetSessionKey: "agent:main:slack:channel:C1:thread:100.200",
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C1",
    sessionId: "source-uuid",
    channelId: "slack",
    accountId: "workspace-1",
    parentConversationId: "C1",
    threadId: "100.200",
    starterMessageId: "100.201",
    starterText: "Please do the work.",
    deliveryContext: {
      channel: "slack",
      to: "channel:C1",
      accountId: "workspace-1",
      threadId: "100.200",
    },
    createdAt: 1_000,
    state: "pending",
    ...overrides,
  };
}
