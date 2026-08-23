export class AlprojectError extends Error {
  readonly code: AlprojectErrorCode;

  constructor(code: AlprojectErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AlprojectError";
    this.code = code;
  }
}

export type AlprojectErrorCode = "configuration" | "filesystem" | "lock" | "registry";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
