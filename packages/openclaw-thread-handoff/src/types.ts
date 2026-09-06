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
  schemaVersion: 1;
  routeKey: string;
  handoffId: string;
  targetSessionKey: string;
  threadId: string;
  starterMessageId?: string;
  starterText: string;
  deliveryContext: DeliveryRoute;
  createdAt: number;
  lastEnqueuedAt?: number;
  state: "pending" | "claimed";
  claimedAt?: number;
}

export interface PluginConfiguration {
  channelSurfaces: Record<string, "slack" | "discord">;
}

export interface ToolSuccess {
  status: "queued" | "alreadyStarted" | "claimed" | "alreadyClaimed" | "none";
  handoffId?: string;
  sessionKey?: string;
}

export type HandoffErrorCode =
  | "unsupportedContext"
  | "unverifiedThreadDelivery"
  | "conflictingHandoff"
  | "invalidTarget"
  | "unavailablePersistentState";
