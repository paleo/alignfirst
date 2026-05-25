import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusPollResult,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
} from "./protocol.js";

export type {
  QaBusAttachment,
  QaBusConversation,
  QaBusConversationKind,
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusEvent,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusPollResult,
  QaBusReactToMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
  QaBusWaitForInput,
} from "./protocol.js";

type JsonResult<T> = Promise<T>;

function buildQaBusUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), normalizedBaseUrl);
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): JsonResult<T> {
  const url = buildQaBusUrl(baseUrl, path).toString();
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
    policy: { allowPrivateNetwork: true },
    auditContext: "channel-mock.bus-post",
  });
  try {
    const text = await response.text();
    let parsed: T | { error?: string };
    try {
      parsed = text ? (JSON.parse(text) as T | { error?: string }) : ({} as T);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!response.ok) {
      const error =
        typeof parsed === "object" && parsed && "error" in parsed ? parsed.error : undefined;
      throw new Error(error || `test bus request failed: ${response.status}`);
    }
    return parsed as T;
  } finally {
    await release();
  }
}

export function normalizeQaTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function parseQaTarget(raw: string): {
  chatType: "direct" | "channel" | "group";
  conversationId: string;
  threadId?: string;
} {
  const normalized = normalizeQaTarget(raw);
  if (!normalized) {
    throw new Error("channel-mock target is required");
  }
  if (normalized.startsWith("thread:")) {
    const rest = normalized.slice("thread:".length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      throw new Error(`invalid channel-mock thread target: ${normalized}`);
    }
    return {
      chatType: "channel",
      conversationId: rest.slice(0, slashIndex),
      threadId: rest.slice(slashIndex + 1),
    };
  }
  if (normalized.startsWith("channel:")) {
    return {
      chatType: "channel",
      conversationId: normalized.slice("channel:".length),
    };
  }
  if (normalized.startsWith("group:")) {
    return {
      chatType: "group",
      conversationId: normalized.slice("group:".length),
    };
  }
  if (normalized.startsWith("dm:")) {
    return {
      chatType: "direct",
      conversationId: normalized.slice("dm:".length),
    };
  }
  return {
    chatType: "direct",
    conversationId: normalized,
  };
}

export function buildQaTarget(params: {
  chatType: "direct" | "channel" | "group";
  conversationId: string;
  threadId?: string | null;
}) {
  if (params.threadId) {
    return `thread:${params.conversationId}/${params.threadId}`;
  }
  return `${params.chatType === "direct" ? "dm" : params.chatType}:${params.conversationId}`;
}

export async function pollQaBus(params: {
  baseUrl: string;
  accountId: string;
  cursor: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<QaBusPollResult> {
  return await postJson<QaBusPollResult>(
    params.baseUrl,
    "/v1/poll",
    {
      accountId: params.accountId,
      cursor: params.cursor,
      timeoutMs: params.timeoutMs,
    },
    params.signal,
  );
}

export async function sendQaBusMessage(params: {
  baseUrl: string;
  accountId: string;
  to: string;
  text: string;
  senderId?: string;
  senderName?: string;
  threadId?: string;
  replyToId?: string;
  attachments?: import("./protocol.js").QaBusAttachment[];
  toolCalls?: QaBusToolCall[];
}) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/outbound/message", params);
}

export async function createQaBusThread(params: {
  baseUrl: string;
  accountId: string;
  conversationId: string;
  title: string;
  createdBy?: string;
}) {
  return await postJson<{ thread: QaBusThread }>(
    params.baseUrl,
    "/v1/actions/thread-create",
    params,
  );
}

export async function reactToQaBusMessage(params: {
  baseUrl: string;
  accountId: string;
  messageId: string;
  emoji: string;
  senderId?: string;
}) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/react", params);
}

export async function editQaBusMessage(params: {
  baseUrl: string;
  accountId: string;
  messageId: string;
  text: string;
}) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/edit", params);
}

export async function deleteQaBusMessage(params: {
  baseUrl: string;
  accountId: string;
  messageId: string;
}) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/delete", params);
}

export async function readQaBusMessage(params: {
  baseUrl: string;
  accountId: string;
  messageId: string;
}) {
  return await postJson<{ message: QaBusMessage }>(params.baseUrl, "/v1/actions/read", params);
}

export async function searchQaBusMessages(params: {
  baseUrl: string;
  input: QaBusSearchMessagesInput;
}) {
  return await postJson<{ messages: QaBusMessage[] }>(
    params.baseUrl,
    "/v1/actions/search",
    params.input,
  );
}

export async function injectQaBusInboundMessage(params: {
  baseUrl: string;
  input: QaBusInboundMessageInput;
}) {
  return await postJson<{ message: QaBusMessage }>(
    params.baseUrl,
    "/v1/inbound/message",
    params.input,
  );
}

export async function getQaBusState(baseUrl: string): Promise<QaBusStateSnapshot> {
  const { response, release } = await fetchWithSsrFGuard({
    url: buildQaBusUrl(baseUrl, "/v1/state").toString(),
    policy: { allowPrivateNetwork: true },
    auditContext: "channel-mock.bus-state",
  });
  try {
    if (!response.ok) {
      throw new Error(`test bus request failed: ${response.status}`);
    }
    return (await response.json()) as QaBusStateSnapshot;
  } finally {
    await release();
  }
}
