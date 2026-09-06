import { randomUUID } from "node:crypto";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { HandoffError } from "./errors.js";
import type { ReceiptCoordinator } from "./receipts.js";
import {
  assertSupportedSource,
  createHandoffRecord,
  evidenceMatches,
  readSourceContext,
  resolveHandoffRoute,
} from "./routing.js";
import type { HandoffService } from "./service.js";
import type { HandoffStore } from "./state.js";
import type { PluginConfiguration, ToolSuccess } from "./types.js";

export const threadHandoffParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("start"),
      threadId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("claim"),
      handoffId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);

export function createThreadHandoffTool(params: {
  context: OpenClawPluginToolContext;
  configuration: PluginConfiguration;
  receipts: ReceiptCoordinator;
  getStore: () => HandoffStore;
  service: HandoffService;
  now?: () => number;
}) {
  params.receipts.captureContext(params.context);
  return {
    name: "thread_handoff",
    label: "Thread handoff",
    description:
      "Start a confirmed native thread session or claim its durable handoff before task work.",
    parameters: threadHandoffParameters,
    async execute(_toolCallId: string, input: unknown) {
      try {
        const result = await executeAction(params, parseInput(input));
        return jsonResult(result);
      } catch (error) {
        throw presentError(error);
      }
    },
  };
}

type ToolInput = { action: "start"; threadId: string } | { action: "claim"; handoffId?: string };

async function executeAction(
  params: Parameters<typeof createThreadHandoffTool>[0],
  input: ToolInput,
): Promise<ToolSuccess> {
  const source = readSourceContext(params.context, params.configuration);
  if (!source) {
    throw new HandoffError("unsupportedContext", "Trusted channel session context is unavailable.");
  }
  if (input.action === "claim") {
    const result = params.getStore().claimHandoff(
      {
        targetSessionKey: source.sessionKey,
        agentId: source.agentId,
        ...(source.accountId ? { accountId: source.accountId } : {}),
        ...(input.handoffId ? { handoffId: input.handoffId } : {}),
      },
      (params.now ?? Date.now)(),
    );
    if (input.handoffId && result.status === "none") {
      throw new HandoffError("invalidTarget", "The requested handoff does not exist.");
    }
    return { status: result.status };
  }
  const surface = assertSupportedSource(source, params.configuration);
  const route = resolveHandoffRoute(source, input.threadId, surface);
  return params.service.runForTarget(route.targetSessionKey, async () => {
    const store = params.getStore();
    const existing = store.findHandoffByRoute(route.routeKey);
    if (existing) {
      if (!sourceMatchesExisting(existing, source, input.threadId)) {
        throw new HandoffError(
          "conflictingHandoff",
          "This target already belongs to different delivery evidence.",
        );
      }
      if (existing.state === "pending") await params.service.enqueue(existing);
      return {
        status: "alreadyStarted",
        handoffId: existing.handoffId,
        sessionKey: existing.targetSessionKey,
      };
    }
    const receipt = await params.receipts.waitForReceipt({
      sourceSessionKey: source.sessionKey,
      sourceSessionId: source.sessionId,
      threadId: input.threadId,
    });
    if (!receipt) {
      throw new HandoffError(
        "unverifiedThreadDelivery",
        "No confirmed starter delivery exists for this thread in the current session.",
      );
    }
    const record = createHandoffRecord({
      receipt,
      route,
      handoffId: randomUUID(),
      createdAt: (params.now ?? Date.now)(),
    });
    const inserted = store.insertHandoff(record);
    if (!inserted.inserted) {
      if (!evidenceMatches(inserted.record, receipt)) {
        throw new HandoffError(
          "conflictingHandoff",
          "This target already belongs to different delivery evidence.",
        );
      }
      if (inserted.record.state === "pending") await params.service.enqueue(inserted.record);
      return {
        status: "alreadyStarted",
        handoffId: inserted.record.handoffId,
        sessionKey: inserted.record.targetSessionKey,
      };
    }
    await params.service.enqueue(record);
    return { status: "queued", handoffId: record.handoffId, sessionKey: record.targetSessionKey };
  });
}

function sourceMatchesExisting(
  record: ReturnType<typeof createHandoffRecord>,
  source: NonNullable<ReturnType<typeof readSourceContext>>,
  threadId: string,
): boolean {
  return (
    record.sessionKey === source.sessionKey &&
    record.sessionId === source.sessionId &&
    record.agentId === source.agentId &&
    record.channelId === source.channelId &&
    record.accountId === source.accountId &&
    record.parentConversationId === source.parentConversationId &&
    record.threadId === threadId
  );
}

function parseInput(value: unknown): ToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidInput();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.action === "start") {
    if (keys.some((key) => key !== "action" && key !== "threadId")) return invalidInput();
    return { action: "start", threadId: requiredString(record.threadId) };
  }
  if (record.action === "claim") {
    if (keys.some((key) => key !== "action" && key !== "handoffId")) return invalidInput();
    const handoffId = optionalString(record.handoffId);
    return { action: "claim", ...(handoffId ? { handoffId } : {}) };
  }
  return invalidInput();
}

function requiredString(value: unknown): string {
  const normalized = optionalString(value);
  if (!normalized) return invalidInput();
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) return invalidInput();
  return value.trim();
}

function invalidInput(): never {
  throw new HandoffError("invalidTarget", "Invalid thread_handoff input.");
}

function presentError(error: unknown): Error {
  if (!(error instanceof HandoffError))
    return error instanceof Error ? error : new Error(String(error));
  const cause = error.causeCode ? ` (${error.causeCode})` : "";
  return new Error(`${error.code}${cause}: ${error.message}`, { cause: error });
}
