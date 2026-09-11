import { randomUUID } from "node:crypto";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { type Static, Type } from "typebox";
import { HandoffError } from "./errors.js";
import type { ReceiptCoordinator } from "./receipts.js";
import type { RunIdCache } from "./run-ids.js";
import {
  assertSupportedSource,
  createHandoffRecord,
  evidenceMatches,
  readSourceContext,
  resolveHandoffRoute,
} from "./routing.js";
import type { HandoffService } from "./service.js";
import type { HandoffStore } from "./state.js";
import type { HandoffRecord, PluginConfiguration, SourceContext, ToolSuccess } from "./types.js";

const threadHandoffParameters = Type.Union([
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
      handoffId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

type ToolInput = Static<typeof threadHandoffParameters>;

export interface ThreadHandoffToolParams {
  context: OpenClawPluginToolContext;
  configuration: PluginConfiguration;
  receipts: ReceiptCoordinator;
  runIds: RunIdCache;
  getStore: () => HandoffStore;
  service: HandoffService;
  now?: () => number;
}

export function createThreadHandoffTool(params: ThreadHandoffToolParams) {
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

async function executeAction(
  params: ThreadHandoffToolParams,
  input: ToolInput,
): Promise<ToolSuccess> {
  const source = readSourceContext(params.context, params.configuration);
  if (!source) {
    throw new HandoffError("unsupportedContext", "Trusted channel session context is unavailable.");
  }
  if (input.action === "claim") return claimHandoff(params, source, input.handoffId);
  return startHandoff(params, source, input.threadId);
}

function claimHandoff(
  params: ThreadHandoffToolParams,
  source: SourceContext,
  handoffId: string | undefined,
): ToolSuccess {
  const runId = params.runIds.read(source.sessionKey, source.sessionId);
  const result = params.getStore().claimHandoff(
    {
      targetSessionKey: source.sessionKey,
      agentId: source.agentId,
      sessionId: source.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      ...(source.accountId ? { accountId: source.accountId } : {}),
      ...(handoffId ? { handoffId } : {}),
    },
    (params.now ?? Date.now)(),
  );
  if (handoffId && result.status === "none") {
    throw new HandoffError("invalidTarget", "The requested handoff does not exist.");
  }
  return {
    status: result.status,
    ...(result.status === "alreadyClaimed" && result.record?.claimedAt !== undefined
      ? { claimedAt: result.record.claimedAt }
      : {}),
  };
}

async function startHandoff(
  params: ThreadHandoffToolParams,
  source: SourceContext,
  threadId: string,
): Promise<ToolSuccess> {
  const surface = assertSupportedSource(source, params.configuration);
  const route = resolveHandoffRoute(source, threadId, surface);
  return params.service.runForTarget(route.targetSessionKey, async () => {
    const store = params.getStore();
    const existing = store.findHandoffByRoute(route.routeKey);
    if (existing) {
      if (!sourceMatchesExisting(existing, source, threadId)) throw conflictingHandoff();
      return resumeExisting(params.service, existing);
    }
    const receipt = await params.receipts.waitForReceipt({
      sourceSessionKey: source.sessionKey,
      sourceSessionId: source.sessionId,
      threadId,
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
      if (!evidenceMatches(inserted.record, receipt)) throw conflictingHandoff();
      return resumeExisting(params.service, inserted.record);
    }
    await params.service.startTurn(record);
    return { status: "queued", handoffId: record.handoffId, sessionKey: record.targetSessionKey };
  });
}

function sourceMatchesExisting(
  record: HandoffRecord,
  source: SourceContext,
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

function conflictingHandoff(): HandoffError {
  return new HandoffError(
    "conflictingHandoff",
    "This target already belongs to different delivery evidence.",
  );
}

/** A record whose first attempt never started gets its seed now; otherwise nothing to redo. */
async function resumeExisting(
  service: HandoffService,
  record: HandoffRecord,
): Promise<ToolSuccess> {
  if (record.state === "pending" && record.attemptCount === 0) await service.startTurn(record);
  return {
    status: "alreadyStarted",
    handoffId: record.handoffId,
    sessionKey: record.targetSessionKey,
  };
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
    const handoffId = blankAsAbsent(record.handoffId);
    return { action: "claim", ...(handoffId ? { handoffId } : {}) };
  }
  return invalidInput();
}

// A human turn without a seed sometimes sends `handoffId: ""` rather than omitting the field.
function blankAsAbsent(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string") return invalidInput();
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
