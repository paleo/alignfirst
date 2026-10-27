import { createServer } from "node:net";

import { ConfigError, WorkspaceError } from "./errors.js";
import { devCmd, wsCmd } from "./package-manager.js";

/** The Fetch Standard's bad ports: browsers refuse to load them. Never allocated. */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const PROBE_HOSTS = ["127.0.0.1", "::1"];

const ENTRY_KEYS: ReadonlySet<string> = new Set(["name", "range", "mainWorktree"]);

const UPGRADE_POINTER =
  'Follow "Declare Workspace Ports" in the alignfirst-upgrade reference of the ' +
  "alignfirst-setup-guide skill.";

/** The project's port range and the ports declared in it. */
export interface DevPortsConfig {
  first: number;
  last: number;
  /** Ports never allocated: single ports or inclusive ranges, inside `first`–`last`. */
  exclude?: (number | PortRange)[];
  /** One port per entry, allocated in this order. A string is a name without settings. */
  declare: (string | DeclaredPort)[];
}

export interface DeclaredPort {
  name: string;
  /**
   * A block of `first`–`last` dedicated to this name: it is allocated only there, and no other name
   * is. Two ranges never overlap.
   */
  range?: PortRange;
  /**
   * The main worktree's fixed port. Reserved: never allocated to another workspace, and kept by
   * `--reset-ports`. Inside `range` when declared, outside every range otherwise.
   */
  mainWorktree?: number;
}

export interface PortRange {
  first: number;
  last: number;
}

/** {@link DevPortsConfig} once validated, with its exclusions expanded. */
export interface ResolvedDevPorts {
  first: number;
  last: number;
  /** The declared names, in allocation order. */
  names: string[];
  excluded: ReadonlySet<number>;
  /** The dedicated ranges, by name. */
  ranges: Record<string, PortRange>;
  /** The main worktree's pins, by name. */
  mainWorktree: Record<string, number>;
}

export function resolveDevPortsConfig(config: DevPortsConfig): ResolvedDevPorts {
  refuseOldKeys(config);
  checkPort(config.first, "ports.first");
  checkPort(config.last, "ports.last");
  if (config.first > config.last) {
    throw new ConfigError(
      `Config error: \`ports.first\` (${config.first}) is greater than \`ports.last\` (${config.last}).`,
    );
  }
  const excluded = expandExclusions(config);
  const entries = readEntries(config.declare);
  const resolved: ResolvedDevPorts = {
    first: config.first,
    last: config.last,
    names: entries.map((entry) => entry.name),
    excluded,
    ranges: Object.fromEntries(
      entries.flatMap(({ name, range }) => (range ? [[name, range]] : [])),
    ),
    mainWorktree: Object.fromEntries(
      entries.flatMap(({ name, mainWorktree }) =>
        mainWorktree === undefined ? [] : [[name, mainWorktree]],
      ),
    ),
  };
  Object.setPrototypeOf(resolved.ranges, null);
  Object.setPrototypeOf(resolved.mainWorktree, null);
  checkRanges(resolved);
  checkPins(resolved);
  return resolved;
}

function refuseOldKeys(config: DevPortsConfig): void {
  if (!("names" in config) && !("mainWorktree" in config)) return;
  throw new ConfigError(
    "Config error: `ports.names` became `ports.declare`, and the `ports.mainWorktree` pins moved " +
      `into its entries, as \`{ name, mainWorktree }\`. ${UPGRADE_POINTER}`,
  );
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

function readEntries(declare: unknown): DeclaredPort[] {
  if (!Array.isArray(declare)) {
    throw new ConfigError("Config error: `ports.declare` must be an array of declared ports.");
  }
  const seen = new Set<string>();
  return declare.map((item: unknown, index) => {
    const entry = readEntry(item, index);
    if (seen.has(entry.name)) {
      throw new ConfigError(`Config error: \`ports.declare\` declares "${entry.name}" twice.`);
    }
    seen.add(entry.name);
    return entry;
  });
}

function readEntry(item: unknown, index: number): DeclaredPort {
  if (typeof item === "string" && item !== "") return { name: item };
  if (
    typeof item !== "object" ||
    item === null ||
    !("name" in item) ||
    typeof item.name !== "string" ||
    item.name === ""
  ) {
    throw new ConfigError(
      `Config error: \`ports.declare[${index}]\` must be a non-empty name, or an object with a ` +
        "non-empty string `name`.",
    );
  }
  const name = item.name;
  const unknownKey = Object.keys(item).find((key) => !ENTRY_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new ConfigError(
      `Config error: ${entryLabel(name)}: unknown key \`${unknownKey}\`. The keys are \`name\`, ` +
        "`range` and `mainWorktree`.",
    );
  }
  return {
    name,
    range: readRange("range" in item ? item.range : undefined, name),
    mainWorktree: readPin("mainWorktree" in item ? item.mainWorktree : undefined, name),
  };
}

function readRange(value: unknown, name: string): PortRange | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "object" ||
    value === null ||
    !("first" in value) ||
    !("last" in value) ||
    !isPortNumber(value.first) ||
    !isPortNumber(value.last)
  ) {
    throw new ConfigError(
      `Config error: ${entryLabel(name)}: \`range\` must be \`{ first, last }\`, with integer ports ` +
        "(1–65535).",
    );
  }
  return { first: value.first, last: value.last };
}

function readPin(value: unknown, name: string): number | undefined {
  if (value === undefined) return;
  if (isPortNumber(value)) return value;
  throw new ConfigError(
    `Config error: ${entryLabel(name)}: \`mainWorktree\` must be an integer port (1–65535).`,
  );
}

/** `` `ports.declare` "name" ``, the way a message designates an entry. */
function entryLabel(name: string): string {
  return `\`ports.declare\` "${name}"`;
}

function checkRanges(resolved: ResolvedDevPorts): void {
  const checked: [string, PortRange][] = [];
  for (const [name, range] of Object.entries(resolved.ranges)) {
    const label = `Config error: ${entryLabel(name)}: \`range\` ${formatRange(range)}`;
    if (range.first > range.last) {
      throw new ConfigError(`${label} has its first port greater than its last.`);
    }
    if (range.first < resolved.first || range.last > resolved.last) {
      throw new ConfigError(`${label} must be inside ${formatRange(resolved)}.`);
    }
    const overlapped = checked.find(
      ([, other]) => isInRange(other, range.first) || isInRange(range, other.first),
    );
    if (overlapped) {
      const [otherName, other] = overlapped;
      throw new ConfigError(`${label} overlaps the range ${formatRange(other)} of "${otherName}".`);
    }
    if (!holdsAllowedPort(resolved, range)) {
      throw new ConfigError(`${label} holds no allowed port: each is excluded or a bad port.`);
    }
    checked.push([name, range]);
  }
}

function holdsAllowedPort(resolved: ResolvedDevPorts, range: PortRange): boolean {
  for (let port = range.first; port <= range.last; ++port) {
    if (isAllowed(resolved, port)) return true;
  }
  return false;
}

function checkPins(resolved: ResolvedDevPorts): void {
  const pinnedPorts = new Set<number>();
  for (const [name, port] of Object.entries(resolved.mainWorktree)) {
    if (!isAllowedFor(resolved, name, port)) {
      throw new ConfigError(disallowedPinMessage(resolved, name, port));
    }
    if (pinnedPorts.has(port)) {
      throw new ConfigError(
        `Config error: \`ports.declare\` pins port ${port} twice with \`mainWorktree\`.`,
      );
    }
    pinnedPorts.add(port);
  }
}

function disallowedPinMessage(resolved: ResolvedDevPorts, name: string, port: number): string {
  const label = `Config error: ${entryLabel(name)}: \`mainWorktree\` (${port})`;
  if (isAllowed(resolved, port)) {
    const range = Object.hasOwn(resolved.ranges, name) ? resolved.ranges[name] : undefined;
    if (range) return `${label} must be inside its range ${formatRange(range)}.`;
    const holder = rangeHolding(resolved, port);
    if (holder) {
      const [owner, ownerRange] = holder;
      return `${label} lies in the range ${formatRange(ownerRange)} dedicated to "${owner}".`;
    }
  }
  return `${label} must be inside ${formatRange(resolved)}, neither excluded nor a bad port.`;
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

/** Allowed in the project, and inside the name's range, or outside every range for a name without one. */
function isAllowedFor(resolved: ResolvedDevPorts, name: string, port: number): boolean {
  if (!isAllowed(resolved, port)) return false;
  const range = Object.hasOwn(resolved.ranges, name) ? resolved.ranges[name] : undefined;
  return range ? isInRange(range, port) : rangeHolding(resolved, port) === undefined;
}

/** The dedicated range holding the port, with its name. */
function rangeHolding(resolved: ResolvedDevPorts, port: number): [string, PortRange] | undefined {
  return Object.entries(resolved.ranges).find(([, range]) => isInRange(range, port));
}

function isInRange(range: PortRange, port: number): boolean {
  return port >= range.first && port <= range.last;
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
    const port = Object.hasOwn(input.stored, name) ? input.stored[name] : undefined;
    if (assigned.has(name) || port === undefined) continue;
    const reserved = pinned.has(port) || used.has(port) || (!isMainWorktree && others.has(port));
    if (isAllowedFor(config, name, port) && !reserved) assign(name, port);
  }

  const cursors = new Map<PortRange, number>();
  for (const name of config.names) {
    if (assigned.has(name)) continue;
    const scope = Object.hasOwn(config.ranges, name) ? config.ranges[name] : config;
    let candidate = cursors.get(scope) ?? scope.first;
    for (; candidate <= scope.last; ++candidate) {
      if (!isAllowedFor(config, name, candidate)) continue;
      if (pinned.has(candidate) || used.has(candidate) || others.has(candidate)) continue;
      if (!(await input.isFree(candidate))) continue;
      assign(name, candidate);
      break;
    }
    cursors.set(scope, candidate);
    if (!assigned.has(name)) throw exhaustedRangeError(config, name);
  }
  const ports: Record<string, number> = Object.create(null);
  for (const name of config.names) {
    const port = assigned.get(name);
    if (port !== undefined) ports[name] = port;
  }
  return ports;
}

function exhaustedRangeError(config: ResolvedDevPorts, name: string): WorkspaceError {
  const range = Object.hasOwn(config.ranges, name) ? config.ranges[name] : undefined;
  if (range) {
    return new WorkspaceError(
      `No port left in the range ${formatRange(range)} dedicated to "${name}": the other ports ` +
        "are excluded, held by other workspaces, or busy on this machine. Ports held there under " +
        `other names are freed at those workspaces' next \`${devCmd("setup")}\`. Free some with ` +
        `\`${wsCmd("remove")}\`.`,
    );
  }
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
