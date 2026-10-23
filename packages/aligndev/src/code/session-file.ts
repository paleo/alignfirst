import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CodingAgent } from "./coding-agent.js";

export interface SessionFrontmatter {
  status: "running" | "succeeded" | "failed";
  agent: CodingAgent | null;
  profile: string | null;
  protocol: string | null;
  ticket: string | null;
  model: string | null;
  sessionId: string | null;
  command: string;
  // Opaque caller-supplied handoff string (`aligndev code --meta`). aligndev never interprets it; it exists
  // so the caller can stash context a later reader needs — e.g. an OpenClaw agent stashing the
  // originating thread target so the exec-completion wake can report back in the right thread.
  meta: string | null;
  // aligndev's own pid — lets a later scan tell a live `running` session from a stale record left by
  // an interrupted run.
  pid: number | null;
  // Linux `/proc/<pid>/stat` start time. Distinguishes the original process from a later process
  // that reused its pid; null on platforms without `/proc` and in legacy records.
  pidStartTime: string | null;
  machineId: string | null;
  // Realpath aligndev ran from. Scopes the single-protocol-run guard to the worktree, alongside the
  // ticket (several worktrees share one session tree, through a `.plans/` symlink or the companion
  // directory).
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  exitReason: string | null;
  // Tokens held in the coding agent's context window when the run ended, from its last model
  // response. It measures the conversation, so a resumed session keeps growing across runs; the
  // spec-to-plan decision in the delegation guide reads it. Null when it could not be established,
  // and `contextTokensError` then says why.
  contextTokens: number | null;
  // The agent compacted the conversation during the run. The figure above then covers only what
  // survived: the earlier discussion is gone, summarized.
  contextCompacted: boolean;
  // Why no `contextTokens` figure could be established. Null when one was.
  contextTokensError: string | null;
}

export const RESULT_MARKER = "\n---- Result ----\n";
const LATER_RESULT_SEPARATOR = "\n\n---- Later result ----\n\n";
// A run is written as `<stamp>.running.md` and renamed to `<stamp>.md` when it ends, so the
// work-files sync can leave running logs out by name. Records written before this convention keep
// their name and their `running` status until their run ends.
const RUNNING_SUFFIX = ".running.md";

export function createSessionFile(
  sessionsDir: string,
  ticket: string | undefined,
  now: Date,
  frontmatter: SessionFrontmatter,
): string {
  const dir = join(sessionsDir, ...(ticket === undefined ? [] : [ticket]), "_aligndev");
  mkdirSync(dir, { recursive: true });
  const stamp = formatStamp(now);
  for (let suffix = 1; ; ++suffix) {
    const path = sessionFileCandidate(dir, stamp, suffix);
    if (existsSync(completedSessionPath(path))) continue;
    try {
      claimSessionFile(path, frontmatter);
      return path;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
}

function sessionFileCandidate(dir: string, stamp: string, suffix: number): string {
  return join(dir, `${stamp}${suffix === 1 ? "" : `-${suffix}`}${RUNNING_SUFFIX}`);
}

export function completedSessionPath(sessionFilePath: string): string {
  if (!sessionFilePath.endsWith(RUNNING_SUFFIX)) return sessionFilePath;
  return `${sessionFilePath.slice(0, -RUNNING_SUFFIX.length)}.md`;
}

function claimSessionFile(path: string, frontmatter: SessionFrontmatter): void {
  writeFileSync(path, `${serializeFrontmatter(frontmatter)}\n`, { flag: "wx" });
}

// `sessionsDir` is the `.plans`-shaped directory holding the session directories: the resolved
// `_aligndev` location, which is the resolved `.plans` unless the companion holds a separate tree.
export function resolveSessionFilePath(
  sessionsDir: string,
  ticket: string | undefined,
  now: Date,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const dir = join(sessionsDir, ...(ticket === undefined ? [] : [ticket]), "_aligndev");
  const stamp = formatStamp(now);
  let suffix = 1;
  while (
    fileExists(sessionFileCandidate(dir, stamp, suffix)) ||
    fileExists(completedSessionPath(sessionFileCandidate(dir, stamp, suffix)))
  )
    ++suffix;
  return sessionFileCandidate(dir, stamp, suffix);
}

// Writes the initial `running` header. Present before the run starts so an interrupted run still
// leaves an auditable record; the terminal frontmatter rewrite happens on completion.
export function writeInitialSessionFile(
  sessionFilePath: string,
  frontmatter: SessionFrontmatter,
): void {
  mkdirSync(dirname(sessionFilePath), { recursive: true });
  claimSessionFile(sessionFilePath, frontmatter);
}

export interface CompletionUpdate {
  status: "succeeded" | "failed";
  endedAt: string;
  exitReason: "completed" | "error" | "terminated" | "auth_required";
  sessionId: string | null;
  result: string;
  contextTokens?: number | null;
  contextCompacted?: boolean;
  contextTokensError?: string | null;
}

export function formatResults(earlier: readonly string[], last: string): string {
  return [...earlier, last].join(LATER_RESULT_SEPARATOR);
}

// Appends the result block, then rewrites the frontmatter in place, then renames the file to its
// completed name. Returns that name. Append-first keeps the tailed transcript intact until the
// single terminal rewrite.
export function applyCompletion(sessionFilePath: string, update: CompletionUpdate): string {
  const content = readFileSync(sessionFilePath, "utf-8");
  const { frontmatter, body } = splitSessionFile(content);
  const updated: SessionFrontmatter = {
    ...frontmatter,
    status: update.status,
    endedAt: update.endedAt,
    exitReason: update.exitReason,
    sessionId: update.sessionId ?? frontmatter.sessionId,
    contextTokens: update.contextTokens ?? frontmatter.contextTokens,
    contextCompacted: update.contextCompacted ?? frontmatter.contextCompacted,
    contextTokensError: update.contextTokensError ?? frontmatter.contextTokensError,
  };
  const resultBlock = `${RESULT_MARKER}\n${update.result}\n`;
  writeFileSync(sessionFilePath, `${serializeFrontmatter(updated)}\n${body}${resultBlock}`);
  const completedPath = completedSessionPath(sessionFilePath);
  if (completedPath !== sessionFilePath) renameSync(sessionFilePath, completedPath);
  return completedPath;
}

export function appendTranscript(sessionFilePath: string, text: string): void {
  writeFileSync(sessionFilePath, text, { flag: "a" });
}

export interface SessionCompletion {
  frontmatter: SessionFrontmatter;
  result: string | undefined;
}

// Reads back a completed (or in-progress) session file — the durable result handoff a waking
// OpenClaw agent or a human reads: frontmatter status/sessionId plus the `---- Result ----` block.
export function readCompletion(sessionFilePath: string): SessionCompletion {
  const content = readFileSync(sessionFilePath, "utf-8");
  const { frontmatter } = splitSessionFile(content);
  // `lastIndexOf`, not `indexOf`: `applyCompletion` always appends the real result block last, so a
  // `---- Result ----` echoed earlier in the transcript body (e.g. the agent printing a session
  // file) must not truncate the actual result.
  const markerIndex = content.lastIndexOf(RESULT_MARKER);
  const result =
    markerIndex === -1 ? undefined : content.slice(markerIndex + RESULT_MARKER.length).trim();
  return { frontmatter, result };
}

export interface ReconciledSession extends SessionCompletion {
  // The completed name when sealing renamed the file.
  path: string;
}

export function reconcileSessionFile(
  sessionFilePath: string,
  machineId: string,
  now: Date = new Date(),
): ReconciledSession {
  const completion = readCompletion(sessionFilePath);
  const update = interruptedCompletion(completion.frontmatter, machineId, now);
  if (!update) return { ...completion, path: sessionFilePath };
  return {
    path: applyCompletion(sessionFilePath, update),
    frontmatter: {
      ...completion.frontmatter,
      status: update.status,
      endedAt: update.endedAt,
      exitReason: update.exitReason,
    },
    result: update.result,
  };
}

function interruptedCompletion(
  frontmatter: SessionFrontmatter,
  machineId: string,
  now: Date,
): CompletionUpdate | undefined {
  if (
    frontmatter.status !== "running" ||
    frontmatter.machineId !== machineId ||
    !isRecordedProcessGone(frontmatter)
  )
    return;
  return {
    status: "failed",
    endedAt: now.toISOString(),
    exitReason: "terminated",
    sessionId: frontmatter.sessionId,
    result: `Sealed as interrupted: process ${frontmatter.pid ?? "(unknown)"} is gone.`,
  };
}

function isRecordedProcessGone(frontmatter: SessionFrontmatter): boolean {
  if (frontmatter.pid === null) return false;
  try {
    process.kill(frontmatter.pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
  if (frontmatter.pidStartTime === null) return false;
  const currentStartTime = readPidStartTime(frontmatter.pid);
  return currentStartTime !== null && currentStartTime !== frontmatter.pidStartTime;
}

export function readPidStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fieldsAfterCommand[19] ?? null;
  } catch {
    return null;
  }
}

export interface SessionRecord {
  path: string;
  frontmatter: SessionFrontmatter;
}

// Lists every active session record: `<sessionsDir>/_aligndev/*.md` plus
// `<sessionsDir>/<ticket>/_aligndev/*.md`. Archived tickets move under `_archives/` and leave the
// registry. The session files are the registry — no separate registry file.
// Seals only this installation's conclusively dead runs. Foreign, legacy and uncertain records
// stay untouched and continue to block launches.
export function listSessionRecords(sessionsDir: string, machineId: string): SessionRecord[] {
  const sessionDirs = [join(sessionsDir, "_aligndev")];
  for (const entry of readEntries(sessionsDir)) {
    if (entry.isDirectory() && !entry.name.startsWith("_")) {
      sessionDirs.push(join(sessionsDir, entry.name, "_aligndev"));
    }
  }
  const records: SessionRecord[] = [];
  for (const dir of sessionDirs) {
    for (const entry of readEntries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const completion = reconcileSessionFileOrSkip(join(dir, entry.name), machineId);
      if (completion) records.push({ path: completion.path, frontmatter: completion.frontmatter });
    }
  }
  return records;
}

export function findNewestSessionFile(dir: string): string | undefined {
  let newestName: string | undefined;
  let newestStamp: string | undefined;
  let newestSuffix = -1;
  for (const entry of readEntries(dir)) {
    if (!entry.isFile()) continue;
    const match = /^(\d{8}-\d{6})(?:-(\d+))?(?:\.running)?\.md$/.exec(entry.name);
    if (!match) continue;
    const stamp = match[1];
    const suffix = Number(match[2] ?? 0);
    if (newestStamp !== undefined && stamp < newestStamp) continue;
    if (stamp === newestStamp && suffix <= newestSuffix) continue;
    newestName = entry.name;
    newestStamp = stamp;
    newestSuffix = suffix;
  }
  return newestName === undefined ? undefined : join(dir, newestName);
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A malformed file (e.g. missing its frontmatter block) must not block every future launch.
function reconcileSessionFileOrSkip(
  path: string,
  machineId: string,
): ReconciledSession | undefined {
  try {
    return reconcileSessionFile(path, machineId);
  } catch {
    return;
  }
}

// --- Frontmatter serialization (dependency-free, round-trips with parseFrontmatter) ---

export function serializeFrontmatter(frontmatter: SessionFrontmatter): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${serializeValue(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

function serializeValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return needsQuote(value) ? JSON.stringify(value) : value;
}

function needsQuote(value: string): boolean {
  return value === "" || /[:"#\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || value !== value.trim();
}

interface SplitSessionFile {
  frontmatter: SessionFrontmatter;
  body: string;
}

function splitSessionFile(content: string): SplitSessionFile {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("Session file is missing its frontmatter block.");
  return { frontmatter: parseFrontmatter(match[1]), body: content.slice(match[0].length) };
}

export function parseFrontmatter(block: string): SessionFrontmatter {
  const map: Record<string, string | null> = {};
  for (const line of block.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    map[key] = parseValue(line.slice(index + 1).trim());
  }
  return {
    status: (map.status as SessionFrontmatter["status"]) ?? "running",
    agent: parseAgent(map.agent),
    profile: map.profile ?? null,
    protocol: map.protocol ?? null,
    ticket: map.ticket ?? null,
    model: map.model ?? null,
    sessionId: map.sessionId ?? null,
    command: map.command ?? "",
    meta: map.meta ?? null,
    pid: parsePid(map.pid),
    pidStartTime: map.pidStartTime ?? null,
    machineId: map.machineId ?? null,
    cwd: map.cwd ?? null,
    startedAt: map.startedAt ?? "",
    endedAt: map.endedAt ?? null,
    exitReason: map.exitReason ?? null,
    contextTokens: parseCount(map.contextTokens),
    contextCompacted: map.contextCompacted === "true",
    contextTokensError: map.contextTokensError ?? null,
  };
}

function parseAgent(raw: string | null | undefined): CodingAgent | null {
  return raw === "claude" || raw === "codex" || raw === "pi" ? raw : null;
}

function parsePid(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parseCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseValue(raw: string): string | null {
  if (raw === "") return null;
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    // A partially-written or hand-edited file may hold an unterminated/invalid quoted value; fall
    // back to the raw text so the session file stays readable and sealable instead of crashing.
    return raw;
  }
}

// Local `YYYYMMDD-HHMMSS`.
function formatStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}
