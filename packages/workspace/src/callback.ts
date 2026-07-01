import { createHash } from "node:crypto";
import { relative } from "node:path";

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

// Points OpenClaw at the setup log / slot status and asks it to continue; the outcome is not inlined.
// This maps to OpenClaw's `POST /hooks/agent`, which dispatches an agent turn into the given thread
// session. Body shape is identical to `@paleo/alcoach`'s so both CLIs behave alike.
export function buildCallbackRequest(
  config: CallbackConfig,
  logPath: string,
  slotId: string,
  cwd: string,
): CallbackRequest {
  const relativePath = relative(cwd, logPath);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return {
    url: config.url,
    headers,
    body: {
      sessionKey: config.sessionKey,
      message:
        `The workspace setup finished. Read its log at \`${relativePath}\` ` +
        "(it ends with a `READY:` or `FAILED:` banner carrying the slot status), then continue " +
        "the workflow and report back to the user.",
      idempotencyKey: idempotencyKeyFor(slotId),
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

// Stable per slot identity so OpenClaw dedupes callback retries for the same finalize.
function idempotencyKeyFor(slotId: string): string {
  return createHash("sha256").update(slotId).digest("hex").slice(0, 16);
}
