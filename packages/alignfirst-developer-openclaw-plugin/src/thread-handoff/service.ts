import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { dispatchTurn } from "./dispatch.js";
import type { HandoffStore } from "./state.js";
import type { HandoffRecord, PluginConfiguration, TurnRequest } from "./types.js";
import { errorMessage } from "./values.js";

export const MAX_ATTEMPTS = 10;
export const ATTEMPT_SPACING_MS = 60_000;
const SCAN_INTERVAL_MS = 30_000;

export interface HandoffService {
  startTurn(record: HandoffRecord): Promise<void>;
  runForTarget<T>(targetSessionKey: string, operation: () => Promise<T>): Promise<T>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HandoffServiceParams {
  runtime: OpenClawPluginApi["runtime"];
  configuration: PluginConfiguration;
  getStore: () => HandoffStore;
  logger: PluginLogger;
  now?: () => number;
  scanIntervalMs?: number;
  attemptSpacingMs?: number;
}

export function createHandoffService(params: HandoffServiceParams): HandoffService {
  const now = params.now ?? Date.now;
  const scanIntervalMs = params.scanIntervalMs ?? SCAN_INTERVAL_MS;
  const attemptSpacingMs = params.attemptSpacingMs ?? ATTEMPT_SPACING_MS;
  const targetWork = new Map<string, Promise<unknown>>();
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let scan: Promise<void> | undefined;
  let stopped = true;

  const service: HandoffService = {
    async startTurn(record) {
      if (inFlight.has(record.handoffId)) return;
      const starting = Promise.resolve();
      inFlight.set(record.handoffId, starting);
      try {
        const updated = params.getStore().recordAttempt(record.routeKey, now());
        if (updated?.state !== "pending") return;
        const surface = params.configuration.channelSurfaces[updated.channelId];
        const turn = surface
          ? dispatchTurn({
              runtime: params.runtime,
              logger: params.logger,
              request: buildSeedRequest(updated, surface),
            })
          : Promise.reject(
              new Error(`Channel ${updated.channelId} is not configured for handoff.`),
            );
        const completion = finishAttempt(params, updated, turn, now)
          .finally(() => {
            if (inFlight.get(updated.handoffId) === completion) {
              inFlight.delete(updated.handoffId);
            }
          })
          .catch((error) => {
            reportCompletionFailure(params.logger, updated.handoffId, error);
          });
        inFlight.set(updated.handoffId, completion);
      } finally {
        if (inFlight.get(record.handoffId) === starting) inFlight.delete(record.handoffId);
      }
    },
    runForTarget: (targetSessionKey, operation) =>
      serializeTarget(targetWork, targetSessionKey, operation),
    async start() {
      if (!stopped) return;
      stopped = false;
      params.getStore();
      await recoverPending(service, params, inFlight, now(), attemptSpacingMs);
      timer = setInterval(() => {
        if (scan || stopped) return;
        scan = recoverPending(service, params, inFlight, now(), attemptSpacingMs)
          .catch((error) =>
            params.logger.error(`thread-handoff recovery failed: ${errorMessage(error)}`),
          )
          .finally(() => {
            scan = undefined;
          });
      }, scanIntervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await scan;
    },
  };
  return service;
}

async function recoverPending(
  service: HandoffService,
  params: HandoffServiceParams,
  inFlight: Map<string, Promise<void>>,
  now: number,
  attemptSpacingMs: number,
): Promise<void> {
  const records = params.getStore().listPending({
    now,
    spacingMs: attemptSpacingMs,
    maxAttempts: MAX_ATTEMPTS,
  });
  await Promise.all(
    records
      .filter((record) => !inFlight.has(record.handoffId))
      .map((record) =>
        service
          .runForTarget(record.targetSessionKey, async () => {
            const current = params.getStore().findHandoffByRoute(record.routeKey);
            if (current?.state !== "pending") return;
            await service.startTurn(current);
          })
          .catch((error) =>
            params.logger.error(
              `thread-handoff recovery failed for ${record.handoffId}: ${errorMessage(error)}`,
            ),
          ),
      ),
  );
}

function buildSeedRequest(record: HandoffRecord, surface: "slack" | "discord"): TurnRequest {
  return {
    sessionKey: record.targetSessionKey,
    agentId: record.agentId,
    channelId: record.channelId,
    surface,
    route: record.deliveryContext,
    parentConversationId: record.parentConversationId,
    message: "Take over this thread.",
    messageId: `thread-handoff:${record.handoffId}:${record.attemptCount}`,
  };
}

async function finishAttempt(
  params: HandoffServiceParams,
  record: HandoffRecord,
  turn: Promise<void>,
  now: () => number,
): Promise<void> {
  let failure: unknown;
  try {
    await turn;
  } catch (error) {
    failure = error;
  }
  try {
    const current = params.getStore().recordAttemptEnd(record.routeKey, now());
    if (failure === undefined) {
      params.logger.debug?.(
        `thread-handoff ${record.handoffId} start attempt ${record.attemptCount} completed`,
      );
    } else {
      params.logger.warn(
        `thread-handoff ${record.handoffId} start attempt ${record.attemptCount} failed: ${errorMessage(failure)}`,
      );
    }
    if (current?.state === "pending" && current.attemptCount >= MAX_ATTEMPTS) {
      params.logger.warn(
        `thread-handoff ${record.handoffId} stays pending after ${current.attemptCount} start attempts; it remains claimable by the next human message in the thread; inspect it with: openclaw thread-handoff list`,
      );
    }
  } catch (error) {
    reportCompletionFailure(params.logger, record.handoffId, error);
  }
}

function reportCompletionFailure(logger: PluginLogger, handoffId: string, error: unknown): void {
  try {
    logger.error(
      `thread-handoff ${handoffId} could not finish its start attempt: ${errorMessage(error)}`,
    );
  } catch {
    // A detached completion chain must not reject when its final error report fails.
  }
}

async function serializeTarget<T>(
  work: Map<string, Promise<unknown>>,
  targetSessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = work.get(targetSessionKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  work.set(targetSessionKey, current);
  try {
    return await current;
  } finally {
    if (work.get(targetSessionKey) === current) work.delete(targetSessionKey);
  }
}
