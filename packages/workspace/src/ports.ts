import { ConfigError } from "./errors.js";

/** Port scheme declared by the consumer. Omit it entirely for portless mode. */
export interface PortsConfig {
  /** First port of the main worktree's block. */
  base: number;
  /**
   * Ports reserved per workspace: block size and spacing. Defaults to `names.length`; required
   * with `compute`. Set it explicitly to reserve headroom — adding a name later shifts every
   * workspace's block otherwise.
   */
  perWorkspace?: number;
  /** Maximum workspaces, main worktree included. */
  maxWorkspaces: number;
  /** Named ports mapped to `firstPort + 0`, `firstPort + 1`, ... Exactly one of `names`/`compute`. */
  names?: string[];
  /** Full control over the block's ports. Exactly one of `names`/`compute`. */
  compute?: (ctx: PortComputeContext) => Record<string, number>;
}

/** Context passed to {@link PortsConfig.compute}. */
export interface PortComputeContext {
  /** Workspace block index: 0 for the main worktree, 1.. for linked workspaces. */
  index: number;
  /** `base + perWorkspace * index`. */
  firstPort: number;
}

/** {@link PortsConfig} with its defaults applied. */
export interface ResolvedPortsConfig {
  base: number;
  perWorkspace: number;
  maxWorkspaces: number;
  names?: string[];
  compute?: (ctx: PortComputeContext) => Record<string, number>;
}

export function resolvePortsConfig(config: PortsConfig): ResolvedPortsConfig {
  const hasNames = config.names !== undefined && config.names.length > 0;
  const hasCompute = config.compute !== undefined;
  if (hasNames === hasCompute) {
    throw new ConfigError(
      "Config error: `ports` requires exactly one of `names` (non-empty array) or `compute`.",
    );
  }
  if (typeof config.maxWorkspaces !== "number") {
    throw new ConfigError("Config error: `ports.maxWorkspaces` is required.");
  }
  if (hasCompute && config.perWorkspace === undefined) {
    throw new ConfigError("Config error: `ports.perWorkspace` is required with `compute`.");
  }
  const perWorkspace = config.perWorkspace ?? config.names?.length ?? 0;
  if (config.names && config.names.length > perWorkspace) {
    throw new ConfigError(
      `Config error: \`ports.names\` declares ${config.names.length} ports, ` +
        `more than \`perWorkspace\` (${perWorkspace}).`,
    );
  }
  const resolved: ResolvedPortsConfig = {
    base: config.base,
    perWorkspace,
    maxWorkspaces: config.maxWorkspaces,
  };
  if (config.names) resolved.names = config.names;
  if (config.compute) resolved.compute = config.compute;
  return resolved;
}

export function portsForIndex(
  resolved: ResolvedPortsConfig,
  index: number,
): Record<string, number> {
  const firstPort = firstPortOf(resolved, index);
  if (resolved.compute) {
    const ports = resolved.compute({ index, firstPort });
    checkComputedPorts(ports, resolved, firstPort);
    return ports;
  }
  const ports: Record<string, number> = {};
  resolved.names?.forEach((name, offset) => {
    ports[name] = firstPort + offset;
  });
  return ports;
}

/** A computed port outside `[firstPort, firstPort + perWorkspace)` collides with another block. */
function checkComputedPorts(
  ports: Record<string, number>,
  resolved: ResolvedPortsConfig,
  firstPort: number,
): void {
  for (const [name, port] of Object.entries(ports)) {
    if (port >= firstPort && port < firstPort + resolved.perWorkspace) continue;
    throw new ConfigError(
      `Config error: \`ports.compute\` returned ${name}: ${port}, outside the workspace's block ` +
        `[${firstPort}, ${firstPort + resolved.perWorkspace - 1}]. Raise \`perWorkspace\` or fix \`compute\`.`,
    );
  }
}

export function firstPortOf(resolved: ResolvedPortsConfig, index: number): number {
  return resolved.base + resolved.perWorkspace * index;
}
