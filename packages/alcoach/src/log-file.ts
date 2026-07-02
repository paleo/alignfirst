import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LogFrontmatter {
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
    "Run alcoach from the root of an AlignFirst-managed project."
  );
}

export function resolveLogPath(
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
// leaves an auditable log; the terminal frontmatter rewrite happens on completion.
export function writeInitialLog(logPath: string, frontmatter: LogFrontmatter): void {
  const header = `${serializeFrontmatter(frontmatter)}\n`;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, header);
}

export interface CompletionUpdate {
  status: "succeeded" | "failed";
  endedAt: string;
  exitReason: string;
  sessionId: string | null;
  result: string;
}

// Appends the result block, then rewrites the frontmatter in place. Append-first keeps the tailed
// transcript intact until the single terminal rewrite.
export function applyCompletion(logPath: string, update: CompletionUpdate): void {
  const content = readFileSync(logPath, "utf-8");
  const { frontmatter, body } = splitLog(content);
  const updated: LogFrontmatter = {
    ...frontmatter,
    status: update.status,
    endedAt: update.endedAt,
    exitReason: update.exitReason,
    sessionId: update.sessionId ?? frontmatter.sessionId,
  };
  const resultBlock = `${RESULT_MARKER}\n${update.result}\n`;
  writeFileSync(logPath, `${serializeFrontmatter(updated)}\n${body}${resultBlock}`);
}

export function appendTranscript(logPath: string, text: string): void {
  writeFileSync(logPath, text, { flag: "a" });
}

export interface LogCompletion {
  frontmatter: LogFrontmatter;
  result: string | undefined;
}

// Reads back a completed (or in-progress) log — the durable result handoff a waking OpenClaw agent
// or a human reads: frontmatter status/sessionId plus the `---- Result ----` block.
export function readCompletion(logPath: string): LogCompletion {
  const content = readFileSync(logPath, "utf-8");
  const { frontmatter } = splitLog(content);
  const markerIndex = content.indexOf(RESULT_MARKER);
  const result =
    markerIndex === -1 ? undefined : content.slice(markerIndex + RESULT_MARKER.length).trim();
  return { frontmatter, result };
}

// --- Frontmatter serialization (dependency-free, round-trips with parseFrontmatter) ---

export function serializeFrontmatter(frontmatter: LogFrontmatter): string {
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

interface SplitLog {
  frontmatter: LogFrontmatter;
  body: string;
}

function splitLog(content: string): SplitLog {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("Log file is missing its frontmatter block.");
  return { frontmatter: parseFrontmatter(match[1]), body: content.slice(match[0].length) };
}

export function parseFrontmatter(block: string): LogFrontmatter {
  const map: Record<string, string | null> = {};
  for (const line of block.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    map[key] = parseValue(line.slice(index + 1).trim());
  }
  return {
    status: (map.status as LogFrontmatter["status"]) ?? "running",
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
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

// Local `YYYYMMDD-HHMMSS`.
function formatStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}
