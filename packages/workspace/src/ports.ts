import { createServer } from "node:net";

import { ConfigError, WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";

/** The Fetch Standard's bad ports: browsers refuse to load them. Never allocated. */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const PROBE_HOSTS = ["127.0.0.1", "::1"];

/** The project's port range and the names allocated in it. */
export interface DevPortsConfig {
  /** Must equal `portRange` in `.alignfirst.json`, when that file declares one. */
  first: number;
  last: number;
  /** Ports never allocated: single ports or inclusive ranges, inside `first`–`last`. */
  exclude?: (number | PortRange)[];
  /** One port per name, allocated in this order. */
  names: string[];
  /**
   * Fixed ports of the main worktree, by name. Reserved: never allocated to another workspace, and
   * kept by `--reset-ports`. A name absent here is allocated as usual.
   */
  mainWorktree?: Record<string, number>;
}

export interface PortRange {
  first: number;
  last: number;
}

/** {@link DevPortsConfig} once validated, with its exclusions expanded. */
export interface ResolvedDevPorts {
  first: number;
  last: number;
  names: string[];
  excluded: ReadonlySet<number>;
  /** The main worktree's pins, by name. */
  mainWorktree: Record<string, number>;
}

export function resolveDevPortsConfig(config: DevPortsConfig): ResolvedDevPorts {
  checkPort(config.first, "ports.first");
  checkPort(config.last, "ports.last");
  if (config.first > config.last) {
    throw new ConfigError(
      `Config error: \`ports.first\` (${config.first}) is greater than \`ports.last\` (${config.last}).`,
    );
  }
  const excluded = expandExclusions(config);
  checkNames(config.names);
  const resolved: ResolvedDevPorts = {
    first: config.first,
    last: config.last,
    names: config.names,
    excluded,
    mainWorktree: config.mainWorktree ?? {},
  };
  checkPins(resolved);
  return resolved;
}

function checkPort(value: unknown, label: string): void {
  if (isPortNumber(value)) return;
  throw new ConfigError(`Config error: \`${label}\` must be an integer port (1–65535).`);
}

function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function expandExclusions(config: DevPortsConfig): Set<number> {
  const excluded = new Set<number>();
  for (const item of config.exclude ?? []) {
    const range = typeof item === "number" ? { first: item, last: item } : item;
    checkPort(range.first, "ports.exclude");
    checkPort(range.last, "ports.exclude");
    if (range.first > range.last || range.first < config.first || range.last > config.last) {
      throw new ConfigError(
        `Config error: \`ports.exclude\` entry ${formatRange(range)} is not inside ` +
          `${formatRange(config)}, or its first port is greater than its last.`,
      );
    }
    for (let port = range.first; port <= range.last; ++port) excluded.add(port);
  }
  return excluded;
}

function checkNames(names: unknown): void {
  if (!Array.isArray(names)) {
    throw new ConfigError("Config error: `ports.names` must be an array of port names.");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || name === "") {
      throw new ConfigError("Config error: `ports.names` must hold non-empty strings.");
    }
    if (seen.has(name)) {
      throw new ConfigError(`Config error: \`ports.names\` declares "${name}" twice.`);
    }
    seen.add(name);
  }
}

function checkPins(resolved: ResolvedDevPorts): void {
  const pinnedPorts = new Set<number>();
  for (const [name, port] of Object.entries(resolved.mainWorktree)) {
    const label = `ports.mainWorktree.${name}`;
    if (!resolved.names.includes(name)) {
      throw new ConfigError(`Config error: \`${label}\` pins a name absent from \`ports.names\`.`);
    }
    checkPort(port, label);
    if (!isAllowed(resolved, port)) {
      throw new ConfigError(
        `Config error: \`${label}\` (${port}) must be inside ${formatRange(resolved)}, ` +
          "neither excluded nor a bad port.",
      );
    }
    if (pinnedPorts.has(port)) {
      throw new ConfigError(`Config error: \`ports.mainWorktree\` pins port ${port} twice.`);
    }
    pinnedPorts.add(port);
  }
}

/** In the range, not excluded, not a bad port. */
function isAllowed(resolved: ResolvedDevPorts, port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= resolved.first &&
    port <= resolved.last &&
    !resolved.excluded.has(port) &&
    !BAD_PORTS.has(port)
  );
}

export interface ReconcileInput {
  config: ResolvedDevPorts;
  isMainWorktree: boolean;
  /** The workspace's stored ports; `{}` with `--reset-ports`. */
  stored: Record<string, number>;
  /** Every port stored on the other entries of the registry. */
  others: Iterable<number>;
  /** Whether the port is free on this machine. */
  isFree: (port: number) => Promise<boolean>;
}

/**
 * The workspace's ports, in `names` order: pins first (main worktree only), then the stored ports
 * the config still allows, then a new port for each missing name.
 */
export async function reconcilePorts(input: ReconcileInput): Promise<Record<string, number>> {
  const { config, isMainWorktree } = input;
  const others = new Set(input.others);
  const pinned = new Set(Object.values(config.mainWorktree));
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  const assign = (name: string, port: number): void => {
    assigned.set(name, port);
    used.add(port);
  };

  if (isMainWorktree) {
    for (const [name, port] of Object.entries(config.mainWorktree)) assign(name, port);
  }
  for (const name of config.names) {
    const port = input.stored[name];
    if (assigned.has(name) || port === undefined) continue;
    const reserved = pinned.has(port) || used.has(port) || (!isMainWorktree && others.has(port));
    if (isAllowed(config, port) && !reserved) assign(name, port);
  }

  let candidate = config.first;
  for (const name of config.names) {
    if (assigned.has(name)) continue;
    for (; candidate <= config.last; ++candidate) {
      if (!isAllowed(config, candidate) || pinned.has(candidate) || used.has(candidate)) continue;
      if (others.has(candidate) || !(await input.isFree(candidate))) continue;
      assign(name, candidate);
      break;
    }
    if (!assigned.has(name)) throw exhaustedRangeError(config, name);
  }
  const ports: Record<string, number> = {};
  for (const name of config.names) {
    const port = assigned.get(name);
    if (port !== undefined) ports[name] = port;
  }
  return ports;
}

function exhaustedRangeError(config: ResolvedDevPorts, name: string): WorkspaceError {
  return new WorkspaceError(
    `No port left in ${formatRange(config)} for "${name}": the other ports are excluded, ` +
      `held by other workspaces, or busy on this machine. Free some with \`${wsCmd("remove")}\`.`,
  );
}

/** Probes the loopback interfaces with an exclusive listen. A host without IPv6 is skipped. */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if (await isBusyOn(port, host)) return false;
  }
  return true;
}

function isBusyOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(true);
      else if (host === "::1" && isNoIpv6(err)) resolve(false);
      else reject(err);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });
}

function isNoIpv6(err: NodeJS.ErrnoException): boolean {
  return err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT";
}

/** `name=port, …`, in the record's order. */
export function formatPorts(ports: Record<string, number>): string {
  return Object.entries(ports)
    .map(([name, port]) => `${name}=${port}`)
    .join(", ");
}

export function formatRange(range: PortRange): string {
  return `${range.first}..${range.last}`;
}
