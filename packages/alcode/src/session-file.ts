import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionFrontmatter {
  status: "running" | "succeeded" | "failed";
  protocol: string | null;
  ticket: string | null;
  model: string | null;
  sessionId: string | null;
  command: string;
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
  const dir = ticket
    ? join(cwd, ".plans", ticket, "coding-sessions")
    : join(cwd, ".plans", "_coding-sessions");
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
  exitReason: "completed" | "error" | "terminated";
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

// --- Frontmatter serialization (dependency-free, round-trips with parseFrontmatter) ---

export function serializeFrontmatter(frontmatter: SessionFrontmatter): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${serializeValue(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

function serializeValue(value: string | null): string {
  if (value === null) return "";
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
    protocol: map.protocol ?? null,
    ticket: map.ticket ?? null,
    model: map.model ?? null,
    sessionId: map.sessionId ?? null,
    command: map.command ?? "",
    startedAt: map.startedAt ?? "",
    endedAt: map.endedAt ?? null,
    exitReason: map.exitReason ?? null,
  };
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
