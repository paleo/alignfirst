import type { HandoffErrorCode } from "./types.js";

export class HandoffError extends Error {
  readonly code: HandoffErrorCode;
  readonly causeCode?: string;

  constructor(code: HandoffErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HandoffError";
    this.code = code;
    this.causeCode = readCauseCode(cause);
  }
}

function readCauseCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) return;
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
}
