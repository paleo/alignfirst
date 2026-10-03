/**
 * Returns the value stored under `name` for the whole gateway process, created on first use.
 *
 * Since 2026.9.8, OpenClaw evaluates this plugin more than once in one gateway process: a turn
 * takes its tools from the gateway's registration and runs its tool hooks in its own. State that
 * both a tool and a hook read must outlive a single registration.
 */
export function processShared<T>(name: string, create: () => T): T {
  const slots: Record<symbol, unknown> = globalThis;
  const key = Symbol.for(`@alignfirst/service-openclaw-plugin/${name}`);
  if (!(key in slots)) slots[key] = create();
  // The slot holds what `create` returned under this versioned name.
  return slots[key] as T;
}
