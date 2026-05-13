export class StartupError extends Error {
  label: string;
  reason: string;
  logFile: string | undefined;
  constructor(label: string, reason: string, logFile?: string) {
    super(`${label}: ${reason}`);
    this.label = label;
    this.reason = reason;
    this.logFile = logFile;
  }
}

export class ConfigError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
