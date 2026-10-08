// Mirrors bundled Discord's thread adoption (`extensions/discord/src/active-turn-thread-route.ts`):
// a thread created during a turn, anchored on the turn's triggering message in its source channel,
// takes over the turn's final reply delivery. A later `thread-reply` into that thread is the
// turn's current-source reply.

// Keyed by session key. The slot is process-wide: OpenClaw may evaluate a plugin module more than
// once in one gateway process, and the inbound turn and the message action must share the routes.
const activeRoutes = processShared(
  "active-turn-thread-routes/v1",
  () => new Map<string, Set<ActiveTurnThreadRoute>>(),
);

export interface ActiveTurnThreadRoute {
  accountId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  adoptedThread?: AdoptedThread;
}

export interface AdoptedThread {
  conversationId: string;
  threadId: string;
}

export function beginActiveTurnThreadRoute(
  sessionKey: string,
  route: ActiveTurnThreadRoute,
): () => void {
  const routes = activeRoutes.get(sessionKey) ?? new Set<ActiveTurnThreadRoute>();
  routes.add(route);
  activeRoutes.set(sessionKey, routes);
  return () => {
    routes.delete(route);
    if (routes.size === 0 && activeRoutes.get(sessionKey) === routes) {
      activeRoutes.delete(sessionKey);
    }
  };
}

export function notifyActiveTurnThreadCreated(params: {
  sessionKey?: string | null;
  accountId: string;
  sourceChannelId: string;
  sourceMessageId?: string;
  thread: AdoptedThread;
}): void {
  if (params.sessionKey == null || params.sourceMessageId === undefined) return;
  const route = findRoute(
    params.sessionKey,
    (candidate) =>
      candidate.accountId === params.accountId &&
      candidate.sourceChannelId === params.sourceChannelId &&
      candidate.sourceMessageId === params.sourceMessageId,
  );
  if (route) route.adoptedThread = params.thread;
}

export function isActiveTurnAdoptedThread(params: {
  sessionKey?: string | null;
  accountId: string;
  threadId: string;
}): boolean {
  if (params.sessionKey == null) return false;
  const route = findRoute(
    params.sessionKey,
    (candidate) =>
      candidate.accountId === params.accountId &&
      candidate.adoptedThread?.threadId === params.threadId,
  );
  return route !== undefined;
}

function findRoute(
  sessionKey: string,
  predicate: (route: ActiveTurnThreadRoute) => boolean,
): ActiveTurnThreadRoute | undefined {
  return Array.from(activeRoutes.get(sessionKey) ?? []).find(predicate);
}

function processShared<T>(name: string, create: () => T): T {
  const slots: Record<symbol, unknown> = globalThis;
  const key = Symbol.for(`@alignfirst/openclaw-channel-mock-core/${name}`);
  if (!(key in slots)) slots[key] = create();
  // The slot holds what `create` returned under this versioned name.
  return slots[key] as T;
}
