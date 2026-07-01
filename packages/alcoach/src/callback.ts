import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { CallbackConfig } from "./mode.js";

export interface CallbackRequest {
  url: string;
  headers: Record<string, string>;
  body: CallbackBody;
}

export interface CallbackBody {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}

// Points OpenClaw at the log file and nothing more; the result is not inlined and no next action is
// presumed (alcoach does not know the caller's workflow). This maps to OpenClaw's `POST /hooks/agent`,
// which dispatches an agent turn into the given thread session.
export function buildCallbackRequest(
  config: CallbackConfig,
  logPath: string,
  cwd: string,
): CallbackRequest {
  // Absolute path: the callback dispatches an isolated agent turn whose cwd is not alcoach's project
  // cwd, so a cwd-relative path would not resolve for the reader.
  const absolutePath = resolve(cwd, logPath);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return {
    url: config.url,
    headers,
    body: {
      sessionKey: config.sessionKey,
      message: `The agent has finished. The result: \`${absolutePath}\`.`,
      idempotencyKey: idempotencyKeyFor(logPath),
    },
  };
}

export async function fireCallback(request: CallbackRequest): Promise<void> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!response.ok) {
    throw new Error(`Callback POST failed: ${response.status} ${response.statusText}`);
  }
}

// Stable per log file so OpenClaw dedupes callback retries for the same run.
function idempotencyKeyFor(logPath: string): string {
  return createHash("sha256").update(logPath).digest("hex").slice(0, 16);
}
