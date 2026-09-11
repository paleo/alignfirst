export interface DeliveryRoute {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
}

export interface SourceContext {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  channelId: string;
  accountId?: string;
  parentConversationId: string;
  deliveryContext?: DeliveryRoute;
}

export interface DeliveryReceipt extends SourceContext {
  schemaVersion: 1;
  receiptKey: string;
  threadId: string;
  starterMessageId?: string;
  starterText: string;
  toolCallId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface HandoffRecord extends SourceContext {
  schemaVersion: 2;
  routeKey: string;
  handoffId: string;
  targetSessionKey: string;
  threadId: string;
  starterMessageId?: string;
  starterText: string;
  deliveryContext: DeliveryRoute;
  createdAt: number;
  attemptCount: number;
  lastAttemptedAt?: number;
  state: "pending" | "claimed";
  claimedAt?: number;
  claimedBy?: { sessionId: string; runId?: string };
}

export interface ReceiptIdentity {
  sourceSessionKey: string;
  sourceSessionId: string;
  threadId: string;
}

export interface PluginConfiguration {
  channelSurfaces: Record<string, "slack" | "discord">;
}

export interface ToolSuccess {
  status: "queued" | "alreadyStarted" | "claimed" | "alreadyClaimed" | "none";
  handoffId?: string;
  sessionKey?: string;
  claimedAt?: number;
}

export type HandoffErrorCode =
  | "unsupportedContext"
  | "unverifiedThreadDelivery"
  | "conflictingHandoff"
  | "invalidTarget"
  | "unavailablePersistentState";
