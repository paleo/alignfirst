import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "openclaw/plugin-sdk/routing";
import {
  deliveryContextFromSession,
  getSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { dispatchTurn } from "./dispatch.js";
import { HandoffError } from "./errors.js";
import { readConversationId } from "./routing.js";
import type { HandoffStore } from "./state.js";
import type { DeliveryRoute, PluginConfiguration, TurnRequest } from "./types.js";
import { errorMessage, nonempty } from "./values.js";

export const WAKE_METHOD = "alignfirst-developer.wake";

export interface WakeParams {
  sessionKey: string;
  message: string;
}

export type WakeResult = { status: "completed" } | { status: "failed"; error: string };

export interface WakeDependencies {
  configuration: PluginConfiguration;
  getStore: () => HandoffStore;
  logger: PluginLogger;
}

export function registerWakeMethod(api: OpenClawPluginApi, deps: WakeDependencies): void {
  api.registerGatewayMethod(
    WAKE_METHOD,
    async ({ params, respond }) => {
      const sessionKey = nonempty(params.sessionKey);
      const message = nonempty(params.message);
      if (!sessionKey || !message) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey and message are required."),
        );
        return;
      }
      let request: TurnRequest;
      try {
        request = await resolveWakeTarget({
          sessionKey,
          message,
          configuration: deps.configuration,
          getStore: deps.getStore,
          runtime: api.runtime,
        });
      } catch (error) {
        if (!(error instanceof HandoffError)) throw error;
        deps.logger.warn(
          `thread-handoff wake refused for ${sessionKey}: ${error.code}: ${error.message}`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `${error.code}: ${error.message}`),
        );
        return;
      }
      try {
        await dispatchTurn({ runtime: api.runtime, logger: deps.logger, request });
        respond(true, { status: "completed" } satisfies WakeResult);
      } catch (error) {
        const detail = errorMessage(error);
        deps.logger.warn(`thread-handoff wake failed for ${sessionKey}: ${detail}`);
        respond(true, { status: "failed", error: detail } satisfies WakeResult);
      }
    },
    { scope: "operator.write" },
  );
}

export async function resolveWakeTarget(params: {
  sessionKey: string;
  message: string;
  configuration: PluginConfiguration;
  getStore: () => HandoffStore;
  runtime: OpenClawPluginApi["runtime"];
}): Promise<TurnRequest> {
  assertRegularSession(params.sessionKey);
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) throw new HandoffError("invalidTarget", "Unrecognized session key.");

  const cfg = params.runtime.config.current();
  const storePath = params.runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: parsed.agentId,
  });
  const sessionRoute = readDeliveryRoute(
    deliveryContextFromSession(
      getSessionEntry({ agentId: parsed.agentId, sessionKey: params.sessionKey, storePath }),
    ),
  );
  const record = params.getStore().findHandoffByTarget(params.sessionKey);
  const route = sessionRoute ?? record?.deliveryContext;
  if (!route) {
    throw new HandoffError("invalidTarget", "No delivery route is recorded for this session.");
  }

  const surface = params.configuration.channelSurfaces[route.channel];
  if (!surface) {
    throw new HandoffError(
      "unsupportedContext",
      `Channel ${route.channel} is not configured for handoff.`,
    );
  }
  assertChannelThreadSession(params.sessionKey, parsed.rest, route, surface);
  return {
    sessionKey: params.sessionKey,
    agentId: parsed.agentId,
    channelId: route.channel,
    surface,
    route,
    ...(record
      ? { parentConversationId: record.parentConversationId }
      : surface === "slack"
        ? { parentConversationId: readConversationId(route.to) }
        : {}),
    message: params.message,
    messageId: `thread-handoff:wake:${randomUUID()}`,
  };
}

function assertRegularSession(sessionKey: string): void {
  if (
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey)
  ) {
    throw new HandoffError(
      "unsupportedContext",
      "Thread wake requires a regular channel-thread session.",
    );
  }
}

function readDeliveryRoute(value: unknown): DeliveryRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const channel = nonempty(Reflect.get(value, "channel"));
  const to = nonempty(Reflect.get(value, "to"));
  if (!channel || !to) return;
  const accountId = nonempty(Reflect.get(value, "accountId"));
  const rawThreadId = Reflect.get(value, "threadId");
  const threadId = typeof rawThreadId === "number" ? String(rawThreadId) : nonempty(rawThreadId);
  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function assertChannelThreadSession(
  sessionKey: string,
  rest: string,
  route: DeliveryRoute,
  surface: "slack" | "discord",
): void {
  const normalizedRest = rest.toLowerCase();
  if (
    !normalizedRest.startsWith(`${route.channel.toLowerCase()}:`) ||
    !normalizedRest.includes(":channel:")
  ) {
    throw new HandoffError("unsupportedContext", "Thread wake requires a channel-thread session.");
  }
  if (
    surface === "slack" &&
    (parseThreadSessionSuffix(sessionKey).threadId === undefined || route.threadId === undefined)
  ) {
    throw new HandoffError("unsupportedContext", "Slack thread wake requires a thread session.");
  }
}
