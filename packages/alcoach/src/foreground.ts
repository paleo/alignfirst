import { readCompletion, readTranscriptBody, RESULT_MARKER } from "./log-file.js";
import { isProcessAlive } from "./process-utils.js";

export interface Writer {
  write(text: string): void;
}

export interface ForegroundParams {
  logPath: string;
  childPid: number;
  isNew: boolean;
  stdout: Writer;
}

const TAIL_INTERVAL_MS = 300;
const LIVENESS_POLL_MS = 700;

// Tail the transcript live until the result marker, then wait for the runner to exit and print a
// clean `Session ID:` + result block. The transcript offset is tracked in body space (past the
// frontmatter), so it survives the runner's terminal frontmatter rewrite.
export function runForeground(params: ForegroundParams): Promise<number> {
  return new Promise((resolve) => {
    let printed = 0;
    let transcriptDone = false;

    const tailTimer = setInterval(() => {
      if (transcriptDone) return;
      const body = readTranscriptBody(params.logPath);
      if (body.length <= printed) return;
      let fresh = body.slice(printed);
      const atStart = printed === 0;
      printed = body.length;
      const markerIndex = fresh.indexOf(RESULT_MARKER);
      if (markerIndex !== -1) {
        fresh = fresh.slice(0, markerIndex);
        transcriptDone = true;
      }
      if (atStart) fresh = fresh.replace(/^\n+/, "");
      params.stdout.write(fresh);
    }, TAIL_INTERVAL_MS);

    const pollTimer = setInterval(() => {
      if (isProcessAlive(params.childPid)) return;
      clearInterval(pollTimer);
      clearInterval(tailTimer);
      resolve(finishForeground(params));
    }, LIVENESS_POLL_MS);
  });
}

function finishForeground(params: ForegroundParams): number {
  const { frontmatter, result } = readCompletion(params.logPath);
  if (params.isNew && frontmatter.sessionId) {
    params.stdout.write(`\nSession ID: ${frontmatter.sessionId}\n`);
  }
  if (result) params.stdout.write(`\n${result}\n`);
  return frontmatter.status === "succeeded" ? 0 : 1;
}
