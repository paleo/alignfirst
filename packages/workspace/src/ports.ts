import { ConfigError } from "./errors.js";

const DEFAULT_PER_WORKSPACE = 10;
const DEFAULT_MAX_WORKSPACES = 20;

/** Port scheme declared by the consumer. Omit it entirely for portless mode. */
export interface PortsConfig {
  /** First port of the main worktree's block. */
  base: number;
  /** Ports reserved per workspace: block size and spacing. Defaults to 10. */
  perWorkspace?: number;
  /** Maximum workspaces, main worktree included. Defaults to 20. */
  maxWorkspaces?: number;
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
  const resolved: ResolvedPortsConfig = {
    base: config.base,
    perWorkspace: config.perWorkspace ?? DEFAULT_PER_WORKSPACE,
    maxWorkspaces: config.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES,
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
  if (resolved.compute) return resolved.compute({ index, firstPort });
  const ports: Record<string, number> = {};
  resolved.names?.forEach((name, offset) => {
    ports[name] = firstPort + offset;
  });
  return ports;
}

export function firstPortOf(resolved: ResolvedPortsConfig, index: number): number {
  return resolved.base + resolved.perWorkspace * index;
}
