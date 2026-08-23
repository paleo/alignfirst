import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { AlprojectError, isNodeError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_RETRY_INTERVAL_MS = 25;
const DEFAULT_INCOMPLETE_GRACE_MS = 250;
const CLAIM_PREFIX = "claim-";
const CHOOSING_PREFIX = "choosing-";

export interface RegistryLockOptions {
  incompleteGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  pid?: number;
  processStartMarker?: (pid: number) => string | undefined;
  retryIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

interface LockContext {
  claimPath: string;
  choosingPath: string;
  incompleteGraceMs: number;
  isProcessAlive: (pid: number) => boolean;
  lockPath: string;
  now: () => number;
  owner: LockOwner;
  processStartMarker: (pid: number) => string | undefined;
  retryIntervalMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}

interface LockOwner {
  pid: number;
  startMarker?: string;
  token: string;
}

interface LockClaim extends LockOwner {
  ticket: number;
}

interface ContenderFile {
  name: string;
  path: string;
}

export async function withRegistryLock<T>(
  registryFile: string,
  action: () => T | Promise<T>,
  options: RegistryLockOptions = {},
): Promise<T> {
  const context = lockContext(registryFile, options);
  await acquireLock(context);
  try {
    return await action();
  } finally {
    releaseLock(context);
  }
}

export function registryLockPath(registryFile: string): string {
  return `${registryFile}.lock`;
}

function lockContext(registryFile: string, options: RegistryLockOptions): LockContext {
  const pid = options.pid ?? process.pid;
  const processStartMarker = options.processStartMarker ?? readProcessStartMarker;
  const startMarker = processStartMarker(pid);
  const owner = {
    pid,
    token: randomUUID(),
    ...(startMarker === undefined ? {} : { startMarker }),
  };
  const lockPath = registryLockPath(registryFile);
  return {
    claimPath: join(lockPath, contenderName(CLAIM_PREFIX, owner)),
    choosingPath: join(lockPath, contenderName(CHOOSING_PREFIX, owner)),
    incompleteGraceMs: options.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS,
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    lockPath,
    now: options.now ?? Date.now,
    owner,
    processStartMarker,
    retryIntervalMs: options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    sleep: options.sleep ?? delay,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function acquireLock(context: LockContext): Promise<void> {
  const deadline = context.now() + context.timeoutMs;
  try {
    createClaim(context);
    while (true) {
      const contenders = readContenders(context);
      if (!contenders.choosing && isFirstClaim(context, contenders.claims)) return;
      if (context.now() >= deadline) throw busyError(context.lockPath);
      await context.sleep(context.retryIntervalMs);
    }
  } catch (error) {
    removeContender(context.choosingPath);
    removeContender(context.claimPath);
    removeLockDirectory(context.lockPath);
    throw error;
  }
}

function createClaim(context: LockContext): void {
  createLockDirectory(context.lockPath);
  try {
    writeExclusive(context.choosingPath, context.owner);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      createLockDirectory(context.lockPath);
      writeExclusive(context.choosingPath, context.owner);
    } else {
      throw error;
    }
  }

  try {
    const ticket = nextTicket(readContenders(context).claims);
    writeExclusive(context.claimPath, { ...context.owner, ticket });
  } finally {
    removeContender(context.choosingPath);
  }
}

function readContenders(context: LockContext): { claims: LockClaim[]; choosing: boolean } {
  let files: string[];
  try {
    files = readdirSync(context.lockPath);
  } catch (error) {
    throw lockError(context.lockPath, "cannot read", error);
  }

  const claims: LockClaim[] = [];
  let choosing = false;
  for (const name of files) {
    const contender = { name, path: join(context.lockPath, name) };
    if (name.startsWith(CLAIM_PREFIX)) {
      const claim = readClaim(context, contender);
      if (claim !== undefined) claims.push(claim);
    } else if (name.startsWith(CHOOSING_PREFIX) && contender.path !== context.choosingPath) {
      if (contenderIsLive(context, contender)) choosing = true;
    }
  }
  return { claims, choosing };
}

function readClaim(context: LockContext, contender: ContenderFile): LockClaim | undefined {
  const value = readContenderValue(context, contender);
  if (!isLockClaim(value)) return;
  return value;
}

function contenderIsLive(context: LockContext, contender: ContenderFile): boolean {
  const value = readContenderValue(context, contender);
  return isLockOwner(value);
}

function readContenderValue(context: LockContext, contender: ContenderFile): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(contender.path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (!(error instanceof SyntaxError)) throw lockError(contender.path, "cannot read", error);
  }

  const owner = isLockOwner(value) ? value : ownerFromFilename(contender.name);
  if (owner?.pid === context.owner.pid && owner.token === context.owner.token) {
    return value ?? owner;
  }
  if (owner !== undefined && contenderProcessMatches(context, owner)) {
    return isLockOwner(value) ? value : owner;
  }
  if (owner === undefined && !incompleteGraceElapsed(context, contender.path)) return value;
  removeContender(contender.path);
  return;
}

function contenderProcessMatches(context: LockContext, owner: LockOwner): boolean {
  if (!context.isProcessAlive(owner.pid)) return false;
  if (owner.startMarker === undefined) return true;
  const currentMarker = context.processStartMarker(owner.pid);
  return currentMarker === undefined || currentMarker === owner.startMarker;
}

function isFirstClaim(context: LockContext, claims: LockClaim[]): boolean {
  const ownClaim = claims.find(
    (claim) => claim.pid === context.owner.pid && claim.token === context.owner.token,
  );
  if (ownClaim === undefined) {
    throw lockError(
      context.claimPath,
      "was removed before acquisition",
      new Error("missing claim"),
    );
  }
  return claims.every(
    (claim) =>
      claim === ownClaim ||
      ownClaim.ticket < claim.ticket ||
      (ownClaim.ticket === claim.ticket && ownClaim.token < claim.token),
  );
}

function nextTicket(claims: LockClaim[]): number {
  const highest = claims.reduce((maximum, claim) => Math.max(maximum, claim.ticket), 0);
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new AlprojectError("lock", "Registry lock ticket exceeds safe arithmetic");
  }
  return highest + 1;
}

function writeExclusive(path: string, value: LockOwner | LockClaim): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    throw lockError(path, "cannot create", error);
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    closeSync(descriptor);
  } catch (error) {
    tryClose(descriptor);
    removeContender(path);
    throw lockError(path, "cannot initialize", error);
  }
}

function createLockDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return;
    throw lockError(path, "cannot create", error);
  }
}

function releaseLock(context: LockContext): void {
  removeContender(context.claimPath);
  removeContender(context.choosingPath);
  removeLockDirectory(context.lockPath);
}

function removeContender(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw lockError(path, "cannot remove", error);
  }
}

function removeLockDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return;
    throw lockError(path, "cannot remove", error);
  }
}

function incompleteGraceElapsed(context: LockContext, path: string): boolean {
  try {
    return context.now() - statSync(path).mtimeMs >= context.incompleteGraceMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw lockError(path, "cannot inspect", error);
  }
}

function ownerFromFilename(name: string): LockOwner | undefined {
  const match = /^(?:claim|choosing)-(\d+)-(.+)\.json$/u.exec(name);
  if (match === null) return;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || match[2].length === 0) return;
  return { pid, token: match[2] };
}

function contenderName(prefix: string, owner: LockOwner): string {
  return `${prefix}${owner.pid}-${owner.token}.json`;
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) return false;
  if (!("pid" in value) || !("token" in value)) return false;
  const validStartMarker = !("startMarker" in value) || typeof value.startMarker === "string";
  return (
    validStartMarker &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}

function isLockClaim(value: unknown): value is LockClaim {
  return (
    isLockOwner(value) &&
    "ticket" in value &&
    Number.isSafeInteger(value.ticket) &&
    Number(value.ticket) > 0
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    if (isNodeError(error) && error.code === "EPERM") return true;
    throw new AlprojectError("lock", `Cannot determine whether lock owner PID ${pid} is alive`, {
      cause: error,
    });
  }
}

function readProcessStartMarker(pid: number): string | undefined {
  return readProcStartMarker(pid) ?? readPsStartMarker(pid) ?? readPowerShellStartMarker(pid);
}

function readProcStartMarker(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return;
    const fieldsAfterCommand = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    return startTime === undefined ? undefined : `linux:${startTime}`;
  } catch {
    return;
  }
}

function readPsStartMarker(pid: number): string | undefined {
  try {
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: "pipe",
    }).trim();
    return startTime === "" ? undefined : `ps:${startTime}`;
  } catch {
    return;
  }
}

function readPowerShellStartMarker(pid: number): string | undefined {
  try {
    const startTime = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
    return startTime === "" ? undefined : `powershell:${startTime}`;
  } catch {
    return;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tryClose(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the initialization error.
  }
}

function busyError(path: string): AlprojectError {
  return new AlprojectError(
    "lock",
    `Registry is busy: timed out waiting for ${path}. Retry the command.`,
  );
}

function lockError(path: string, action: string, cause: unknown): AlprojectError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AlprojectError("lock", `Registry lock ${path} ${action}: ${detail}`, { cause });
}
