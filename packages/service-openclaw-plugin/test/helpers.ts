import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { createHandoffStore, type HandoffStore } from "../src/thread-handoff/state.js";
import type { DeliveryReceipt, HandoffRecord } from "../src/thread-handoff/types.js";

const cleanups = new Map<string, Array<() => void | Promise<void>>>();

export function temporaryStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "thread-handoff-test-"));
  const owned: Array<() => void | Promise<void>> = [];
  cleanups.set(root, owned);
  onTestFinished(async () => {
    const failures: unknown[] = [];
    for (const dispose of owned.reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    cleanups.delete(root);
    if (failures.length > 0) throw new AggregateError(failures, `Cleanup failed: ${root}`);
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true });
  });
  return root;
}

export function ownStateResource(root: string, dispose: () => void | Promise<void>): void {
  const owned = cleanups.get(root);
  if (!owned) throw new Error(`State root is not test-owned: ${root}`);
  owned.push(dispose);
}

export function createTestHandoffStore(root: string): HandoffStore {
  const store = createHandoffStore(root);
  const close = store.close.bind(store);
  let closed = false;
  store.close = () => {
    if (closed) return;
    close();
    closed = true;
  };
  ownStateResource(root, () => store.close());
  return store;
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
    schemaVersion: 2,
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
    attemptCount: 0,
    state: "pending",
    ...overrides,
  };
}
