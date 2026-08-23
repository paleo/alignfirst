export class AlprojectError extends Error {
  readonly code: AlprojectErrorCode;

  constructor(code: AlprojectErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AlprojectError";
    this.code = code;
  }
}

export type AlprojectErrorCode = "configuration" | "filesystem" | "lock" | "registry";
