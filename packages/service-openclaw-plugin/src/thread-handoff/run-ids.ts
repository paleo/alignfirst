const RUN_ID_TTL_MS = 60 * 60 * 1_000;
const RUN_ID_LIMIT = 10_000;

export interface RunIdCache {
  remember(context: { sessionKey?: string; sessionId?: string; runId?: string }): void;
  read(sessionKey: string, sessionId: string): string | undefined;
}

interface CachedRunId {
  runId: string;
  capturedAt: number;
}

export function createRunIdCache(now: () => number = Date.now): RunIdCache {
  const entries = new Map<string, CachedRunId>();
  return {
    remember(context) {
      if (
        context.sessionKey === undefined ||
        context.sessionId === undefined ||
        context.runId === undefined
      ) {
        return;
      }
      entries.set(contextKey(context.sessionKey, context.sessionId), {
        runId: context.runId,
        capturedAt: now(),
      });
      pruneEntries(entries, now());
    },
    read(sessionKey, sessionId) {
      const capturedAt = now();
      pruneEntries(entries, capturedAt);
      return entries.get(contextKey(sessionKey, sessionId))?.runId;
    },
  };
}

function pruneEntries(entries: Map<string, CachedRunId>, now: number): void {
  for (const [key, value] of entries) {
    if (value.capturedAt + RUN_ID_TTL_MS <= now) entries.delete(key);
  }
  while (entries.size > RUN_ID_LIMIT) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") return;
    entries.delete(oldest);
  }
}

function contextKey(sessionKey: string, sessionId: string): string {
  return `${sessionKey}\u0000${sessionId}`;
}
