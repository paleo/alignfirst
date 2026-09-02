import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CodingAgent } from "./coding-agent.js";

export interface SessionFrontmatter {
  status: "running" | "succeeded" | "failed";
  agent: CodingAgent | null;
  protocol: string | null;
  ticket: string | null;
  model: string | null;
  sessionId: string | null;
  command: string;
  // Opaque caller-supplied handoff string (`alcode --meta`). alcode never interprets it; it exists
  // so the caller can stash context a later reader needs — e.g. an OpenClaw agent stashing the
  // originating thread target so the exec-completion wake can report back in the right thread.
  meta: string | null;
  // alcode's own pid — lets a later scan tell a live `running` session from a stale record left by
  // an interrupted run.
  pid: number | null;
  // Linux `/proc/<pid>/stat` start time. Distinguishes the original process from a later process
  // that reused its pid; null on platforms without `/proc` and in legacy records.
  pidStartTime: string | null;
  // Realpath alcode ran from. Scopes the single-protocol-run guard to the worktree (worktree
  // `.plans/` symlinks back to the main project, so several worktrees share one `.plans/`).
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  exitReason: string | null;
}

export const RESULT_MARKER = "\n---- Result ----\n";

// The CWD must be an AlignFirst-managed project (a `.plans/` dir marks it). Returns an error message
// when the gate fails, `undefined` when it passes. `--guide`/`--help` bypass this.
export function assertPlansGate(cwd: string): string | undefined {
  if (existsSync(join(cwd, ".plans"))) return;
  return (
    "Error: no `.plans/` directory found in the current directory. " +
    "Run alcode from the root of an AlignFirst-managed project."
  );
}

export function resolveSessionFilePath(
  cwd: string,
  ticket: string | undefined,
  now: Date,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const dir = ticket ? join(cwd, ".plans", ticket, "_alcode") : join(cwd, ".plans", "_alcode");
  const stamp = formatStamp(now);
  let candidate = join(dir, `${stamp}.md`);
  let suffix = 2;
  while (fileExists(candidate)) {
    candidate = join(dir, `${stamp}-${suffix}.md`);
    ++suffix;
  }
  return candidate;
}

// Writes the initial `running` header. Present before the run starts so an interrupted run still
// leaves an auditable record; the terminal frontmatter rewrite happens on completion.
export function writeInitialSessionFile(
  sessionFilePath: string,
  frontmatter: SessionFrontmatter,
): void {
  const header = `${serializeFrontmatter(frontmatter)}\n`;
  mkdirSync(dirname(sessionFilePath), { recursive: true });
  writeFileSync(sessionFilePath, header);
}

export interface CompletionUpdate {
  status: "succeeded" | "failed";
  endedAt: string;
  exitReason: "completed" | "error" | "terminated" | "auth_required";
  sessionId: string | null;
  result: string;
}

// Appends the result block, then rewrites the frontmatter in place. Append-first keeps the tailed
// transcript intact until the single terminal rewrite.
export function applyCompletion(sessionFilePath: string, update: CompletionUpdate): void {
  const content = readFileSync(sessionFilePath, "utf-8");
  const { frontmatter, body } = splitSessionFile(content);
  const updated: SessionFrontmatter = {
    ...frontmatter,
    status: update.status,
    endedAt: update.endedAt,
    exitReason: update.exitReason,
    sessionId: update.sessionId ?? frontmatter.sessionId,
  };
  const resultBlock = `${RESULT_MARKER}\n${update.result}\n`;
  writeFileSync(sessionFilePath, `${serializeFrontmatter(updated)}\n${body}${resultBlock}`);
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

export function reconcileSessionFile(
  sessionFilePath: string,
  now: Date = new Date(),
): SessionCompletion {
  const completion = readCompletion(sessionFilePath);
  const update = interruptedCompletion(completion.frontmatter, now);
  if (!update) return completion;
  applyCompletion(sessionFilePath, update);
  return {
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
  now: Date,
): CompletionUpdate | undefined {
  if (frontmatter.status !== "running" || isRecordedProcessAlive(frontmatter)) return;
  return {
    status: "failed",
    endedAt: now.toISOString(),
    exitReason: "terminated",
    sessionId: frontmatter.sessionId,
    result: `Sealed as interrupted: process ${frontmatter.pid ?? "(unknown)"} is gone.`,
  };
}

function isRecordedProcessAlive(frontmatter: SessionFrontmatter): boolean {
  if (frontmatter.pid === null || !isPidAlive(frontmatter.pid)) return false;
  if (frontmatter.pidStartTime === null) return true;
  const currentStartTime = readPidStartTime(frontmatter.pid);
  return currentStartTime === null || currentStartTime === frontmatter.pidStartTime;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
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

// Lists every session record for a project root: `.plans/_alcode/*.md` plus each ticket's
// `.plans/<ticket>/_alcode/*.md`. The session files are the registry — no separate registry file.
// Self-healing: a `running` record whose pid is gone is a stale leftover from an interrupted run;
// it gets sealed in passing so the launch guards never block on dead state. The returned records
// reflect the post-healing state.
export function listSessionRecords(cwd: string): SessionRecord[] {
  const plansDir = join(cwd, ".plans");
  const sessionDirs = [join(plansDir, "_alcode")];
  for (const entry of readEntries(plansDir)) {
    if (entry.isDirectory() && entry.name !== "_alcode") {
      sessionDirs.push(join(plansDir, entry.name, "_alcode"));
    }
  }
  const records: SessionRecord[] = [];
  for (const dir of sessionDirs) {
    for (const entry of readEntries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const completion = reconcileSessionFileOrSkip(path);
      if (completion) records.push({ path, frontmatter: completion.frontmatter });
    }
  }
  return records;
}

// Work without a ticket: reserves the next free `side-N` under `.plans/`, following the alignfirst
// skill's side-ticket convention. The non-recursive mkdir is the reservation: EEXIST means a
// concurrent reservation took the id, so the loop moves on to the next one.
export function reserveSideTicket(cwd: string): string {
  const plansDir = join(cwd, ".plans");
  const highest = Math.max(
    highestSideTicket(plansDir),
    highestSideTicket(join(plansDir, "_archives")),
  );
  for (let n = highest + 1; ; ++n) {
    const ticket = `side-${n}`;
    try {
      mkdirSync(join(plansDir, ticket));
      return ticket;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

function highestSideTicket(dir: string): number {
  let highest = 0;
  for (const entry of readEntries(dir)) {
    const match = entry.isDirectory() ? entry.name.match(/^side-(\d+)$/) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// A malformed file (e.g. missing its frontmatter block) must not block every future launch.
function reconcileSessionFileOrSkip(path: string): SessionCompletion | undefined {
  try {
    return reconcileSessionFile(path);
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

function serializeValue(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return needsQuote(value) ? JSON.stringify(value) : value;
}

function needsQuote(value: string): boolean {
  return value === "" || /[:"#]/.test(value) || value !== value.trim();
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
    protocol: map.protocol ?? null,
    ticket: map.ticket ?? null,
    model: map.model ?? null,
    sessionId: map.sessionId ?? null,
    command: map.command ?? "",
    meta: map.meta ?? null,
    pid: parsePid(map.pid),
    pidStartTime: map.pidStartTime ?? null,
    cwd: map.cwd ?? null,
    startedAt: map.startedAt ?? "",
    endedAt: map.endedAt ?? null,
    exitReason: map.exitReason ?? null,
  };
}

function parseAgent(raw: string | null | undefined): CodingAgent | null {
  return raw === "claude" || raw === "codex" ? raw : null;
}

function parsePid(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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
