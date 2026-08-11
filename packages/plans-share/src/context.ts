export interface CliContext {
  cwd: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  /** The `plans:sync` script invocation for the package manager that launched us. */
  syncCommand: string;
}

/** A user-facing failure, reported on stderr with exit code 1. */
export class CliError extends Error {}
