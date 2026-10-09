import { ConfigError } from "./errors.js";

/** Port scheme declared by the consumer. Omit it entirely for portless mode. */
export interface PortsConfig {
  /** First port of the scheme. The main worktree's first port in both layouts. */
  base: number;
  /**
   * Ports reserved per workspace, so the maximum ports one workspace can declare. Defaults to
   * `names.length`; required with `compute`. Set it explicitly to reserve headroom. In
   * `workspaceMajor` it is also the spacing between two workspaces' blocks, so adding a name under
   * the default shifts every workspace's block; in `serviceMajor` it is the number of name ranges,
   * and a name added within it moves no existing port.
   */
  perWorkspace?: number;
  /** Maximum workspaces, main worktree included. */
  maxWorkspaces: number;
  /**
   * How the `perWorkspace × maxWorkspaces` ports are arranged. Defaults to `workspaceMajor`.
   *
   * - `workspaceMajor`: each workspace owns a block of `perWorkspace` consecutive ports, and the
   *   `offset`-th name takes `base + perWorkspace × index + offset`.
   * - `serviceMajor`: each name owns a range of `maxWorkspaces` consecutive ports, and workspace
   *   `index` takes the `index`-th port of each: `base + maxWorkspaces × offset + index`. Appending
   *   a name appends a range; no existing port moves.
   *
   * Both span the same `base .. base + perWorkspace × maxWorkspaces − 1` range.
   */
  layout?: PortsLayout;
  /** Named ports mapped to offsets `0`, `1`, ... (see {@link layout}). Exactly one of `names`/`compute`. */
  names?: string[];
  /** Full control over the workspace's ports. Exactly one of `names`/`compute`. */
  compute?: (ctx: PortComputeContext) => Record<string, number>;
}

export type PortsLayout = "workspaceMajor" | "serviceMajor";

/** Context passed to {@link PortsConfig.compute}. */
export interface PortComputeContext {
  /** Workspace index: 0 for the main worktree, 1.. for linked workspaces. */
  index: number;
  /**
   * The port offset `0` takes: `base + perWorkspace × index` in `workspaceMajor`, `base + index` in
   * `serviceMajor`. Consecutive offsets are `1` apart in `workspaceMajor`, `maxWorkspaces` apart
   * in `serviceMajor`.
   */
  firstPort: number;
}

/** {@link PortsConfig} with its defaults applied. */
export interface ResolvedPortsConfig {
  base: number;
  perWorkspace: number;
  maxWorkspaces: number;
  layout: PortsLayout;
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
  if (!Number.isInteger(config.base)) {
    throw new ConfigError("Config error: `ports.base` is required, as an integer.");
  }
  if (!Number.isInteger(config.maxWorkspaces)) {
    throw new ConfigError("Config error: `ports.maxWorkspaces` is required, as an integer.");
  }
  if (hasCompute && config.perWorkspace === undefined) {
    throw new ConfigError("Config error: `ports.perWorkspace` is required with `compute`.");
  }
  const perWorkspace = config.perWorkspace ?? config.names?.length;
  if (perWorkspace === undefined) {
    throw new ConfigError("Config error: `ports.perWorkspace` is required.");
  }
  if (config.names && config.names.length > perWorkspace) {
    throw new ConfigError(
      `Config error: \`ports.names\` declares ${config.names.length} ports, ` +
        `more than \`perWorkspace\` (${perWorkspace}).`,
    );
  }
  const layout = config.layout ?? "workspaceMajor";
  if (layout !== "workspaceMajor" && layout !== "serviceMajor") {
    throw new ConfigError(
      'Config error: `ports.layout` must be "workspaceMajor" or "serviceMajor".',
    );
  }
  const resolved: ResolvedPortsConfig = {
    base: config.base,
    perWorkspace,
    maxWorkspaces: config.maxWorkspaces,
    layout,
  };
  if (config.names) resolved.names = config.names;
  if (config.compute) resolved.compute = config.compute;
  return resolved;
}

export function portsForIndex(
  resolved: ResolvedPortsConfig,
  index: number,
): Record<string, number> {
  if (resolved.compute) {
    const ports = resolved.compute({ index, firstPort: firstPortOf(resolved, index) });
    checkComputedPorts(ports, resolved, index);
    return ports;
  }
  const ports: Record<string, number> = {};
  resolved.names?.forEach((name, offset) => {
    ports[name] = portAt(resolved, index, offset);
  });
  return ports;
}

/**
 * A computed port the workspace does not own — no offset below `perWorkspace` reaches it —
 * collides with another workspace.
 */
function checkComputedPorts(
  ports: Record<string, number>,
  resolved: ResolvedPortsConfig,
  index: number,
): void {
  for (const [name, port] of Object.entries(ports)) {
    if (ownsPort(resolved, index, port)) continue;
    throw new ConfigError(
      `Config error: \`ports.compute\` returned ${name}: ${port}, outside the workspace's ` +
        `${describeOwnedPorts(resolved, index)}. Raise \`perWorkspace\` or fix \`compute\`.`,
    );
  }
}

function ownsPort(resolved: ResolvedPortsConfig, index: number, port: number): boolean {
  const distance = port - firstPortOf(resolved, index);
  const step = offsetStep(resolved);
  return distance >= 0 && distance % step === 0 && distance / step < resolved.perWorkspace;
}

function describeOwnedPorts(resolved: ResolvedPortsConfig, index: number): string {
  const first = firstPortOf(resolved, index);
  const last = portAt(resolved, index, resolved.perWorkspace - 1);
  if (resolved.layout === "workspaceMajor") return `block [${first}, ${last}]`;
  return `ports ${first}, ${first + offsetStep(resolved)}, … ${last} (every ${offsetStep(resolved)})`;
}

/** The port offset `0` takes in workspace `index`: the block's first port in `workspaceMajor`. */
export function firstPortOf(resolved: ResolvedPortsConfig, index: number): number {
  return portAt(resolved, index, 0);
}

/** The port the `offset`-th name takes in workspace `index`. */
export function portAt(resolved: ResolvedPortsConfig, index: number, offset: number): number {
  if (resolved.layout === "serviceMajor") {
    return resolved.base + resolved.maxWorkspaces * offset + index;
  }
  return resolved.base + resolved.perWorkspace * index + offset;
}

/** The distance between two consecutive offsets of one workspace. */
function offsetStep(resolved: ResolvedPortsConfig): number {
  return resolved.layout === "serviceMajor" ? resolved.maxWorkspaces : 1;
}
