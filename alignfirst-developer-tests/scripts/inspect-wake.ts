import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const DATABASE_PATH = "/home/claw/.openclaw/agents/main/agent/openclaw-agent.sqlite";

export interface ThreadObservation {
  messageCount: number;
  terminalCount: number;
  openTurn: boolean;
  backgroundResultObserved?: boolean;
  processId?: string;
  pid?: number;
  processExited?: boolean;
  nativeTurnCompleted?: boolean;
  terminalPollObserved?: boolean;
}

interface TranscriptMessage {
  role: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  content?: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  arguments?: { sessionId?: string; action?: string };
}

interface RuntimeEvent {
  type: string;
  data?: {
    prompt?: string;
    status?: string;
    stopReason?: string;
    aborted?: boolean;
    timedOut?: boolean;
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sessionKey, launchId] = process.argv.slice(2);
  if (sessionKey === undefined) throw new Error("session key required");
  process.stdout.write(JSON.stringify(inspectSession(DATABASE_PATH, sessionKey, launchId)));
}

export function inspectSession(
  databasePath: string,
  sessionKey: string,
  launchId?: string,
): ThreadObservation {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`
        SELECT e.event_json FROM transcript_events e
        JOIN session_windows w ON w.session_id = e.session_id
        WHERE w.session_key = ? ORDER BY e.created_at, e.seq
      `)
      .all(sessionKey);
    const messages = rows
      .map((row): TranscriptMessage => {
        if (typeof row.event_json !== "string") throw new Error("Invalid transcript JSON");
        return JSON.parse(row.event_json).message;
      })
      .filter(Boolean);
    const lastMessage = messages.at(-1);
    const terminalCount = messages.filter(isTerminal).length;
    const openTurn = lastMessage !== undefined && !isTerminal(lastMessage);
    return {
      messageCount: messages.length,
      terminalCount,
      openTurn,
      ...(launchId === undefined
        ? {}
        : inspectBackgroundCompletion(database, sessionKey, messages, launchId)),
    };
  } finally {
    database.close();
  }
}

function isTerminal(message: TranscriptMessage) {
  return message.role === "assistant" && message.stopReason === "stop";
}

function inspectBackgroundCompletion(
  database: DatabaseSync,
  sessionKey: string,
  messages: TranscriptMessage[],
  launchId: string,
) {
  const launchResultIndex = messages.findIndex(
    (message) => message.role === "toolResult" && message.toolCallId === launchId,
  );
  if (launchResultIndex === -1) return { backgroundResultObserved: false };
  const text = messageText(messages[launchResultIndex]);
  const processMatch = /Command still running \(session ([^,]+), pid (\d+)\)/u.exec(text);
  if (processMatch === null) {
    throw new Error(`Expected a background exec result for ${launchId}: ${text}`);
  }
  const processId = processMatch[1];
  const pid = Number(processMatch[2]);
  const following = messages.slice(launchResultIndex + 1);
  const nativeTurnCompleted = observedNativeCompletion(database, sessionKey, processId);
  const terminalPollObserved = following.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "process" &&
      messages.some(
        (candidate) =>
          candidate.role === "assistant" &&
          Array.isArray(candidate.content) &&
          candidate.content.some(
            (block) =>
              block.type === "toolCall" &&
              block.id === message.toolCallId &&
              block.arguments?.sessionId === processId &&
              block.arguments.action === "poll",
          ),
      ) &&
      /Process exited with code|Process terminated|Process completed/u.test(messageText(message)),
  );
  return {
    backgroundResultObserved: true,
    processId,
    pid,
    processExited: processExited(pid),
    nativeTurnCompleted,
    terminalPollObserved,
  };
}

function messageText(message: TranscriptMessage) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function processExited(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

function observedNativeCompletion(
  database: DatabaseSync,
  sessionKey: string,
  processId: string,
): boolean {
  const rows = database
    .prepare(`
    SELECT e.run_id, e.event_json FROM trajectory_runtime_events e
    JOIN session_windows w ON w.session_id = e.session_id
    WHERE w.session_key = ?
      AND json_extract(e.event_json, '$.type') IN ('prompt.submitted', 'session.ended')
    ORDER BY e.created_at
  `)
    .all(sessionKey);
  const prefixes = ["completed", "failed"].map(
    (status) => `Exec ${status} (${processId.slice(0, 8)},`,
  );
  const completedRuns = new Set<string>();
  for (const row of rows) {
    if (typeof row.event_json !== "string" || typeof row.run_id !== "string") continue;
    const event: RuntimeEvent = JSON.parse(row.event_json);
    if (event.type === "prompt.submitted" && typeof event.data?.prompt === "string") {
      if (
        event.data.prompt
          .split("\n")
          .some((line) => prefixes.some((prefix) => line.startsWith(prefix)))
      ) {
        completedRuns.add(row.run_id);
      }
    }
    if (
      event.type === "session.ended" &&
      completedRuns.has(row.run_id) &&
      event.data?.status === "success" &&
      event.data.stopReason === "stop" &&
      event.data.aborted !== true &&
      event.data.timedOut !== true
    )
      return true;
  }
  return false;
}
