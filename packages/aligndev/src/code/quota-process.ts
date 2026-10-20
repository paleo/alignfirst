import type { ChildProcessWithoutNullStreams } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 1_048_576;
const TERMINATION_GRACE_MS = 250;
const KILL_GRACE_MS = 1_000;

export interface QuotaProcessProtocol<T> {
  source: string;
  timeoutMs: number;
  start?: (write: (message: unknown) => void) => void;
  stdout: (chunk: string, write: (message: unknown) => void) => T | undefined;
  close?: (code: number | null) => T;
}

interface QuotaProcessState<T> {
  child: ChildProcessWithoutNullStreams;
  protocol: QuotaProcessProtocol<T>;
  completing: boolean;
  closed: boolean;
  bytes: number;
  error?: Error;
  result?: T;
  requestTimer?: NodeJS.Timeout;
  terminationTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  release: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function runQuotaProcess<T>(
  child: ChildProcessWithoutNullStreams,
  protocol: QuotaProcessProtocol<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const state: QuotaProcessState<T> = {
      child,
      protocol,
      completing: false,
      closed: false,
      bytes: 0,
      release: () => {},
      resolve,
      reject,
    };
    state.release = observeProcess(state);
    state.requestTimer = setTimeout(
      () => finish(state, new Error(`${protocol.source} timed out while reading usage limits.`)),
      protocol.timeoutMs,
    );
    try {
      protocol.start?.((message) => writeMessage(state, message));
    } catch {
      finish(state, new Error(`${protocol.source} could not write the quota request.`));
    }
  });
}

function observeProcess<T>(state: QuotaProcessState<T>): () => void {
  const { child, protocol } = state;
  const exitGuard = () => signalChild(state, "SIGKILL");
  const onSignal = () =>
    finish(state, new Error(`${protocol.source} quota request was terminated.`));
  const onError = () =>
    finish(state, new Error(`${protocol.source} quota process could not start.`));
  const onInputError = () =>
    finish(state, new Error(`${protocol.source} could not write the quota request.`));
  const onOutputError = () =>
    finish(state, new Error(`${protocol.source} could not read quota output.`));
  const onStdout = (chunk: string) => readStdout(state, chunk);
  const onStderr = (chunk: string) => acceptOutput(state, chunk);
  const onClose = (code: number | null) => closeProcess(state, code);
  process.on("exit", exitGuard);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  child.on("error", onError);
  child.once("close", onClose);
  child.stdin.on("error", onInputError);
  child.stdout.on("error", onOutputError);
  child.stderr.on("error", onOutputError);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  return () => {
    process.off("exit", exitGuard);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    child.off("error", onError);
    child.off("close", onClose);
    child.stdin.off("error", onInputError);
    child.stdout.off("error", onOutputError);
    child.stderr.off("error", onOutputError);
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
  };
}

function signalChild<T>(state: QuotaProcessState<T>, signal: NodeJS.Signals): void {
  if (state.child.exitCode !== null || state.child.signalCode !== null) return;
  try {
    state.child.kill(signal);
  } catch {
    state.error = new Error(`${state.protocol.source} quota process could not be terminated.`);
  }
}

function finish<T>(state: QuotaProcessState<T>, error?: Error, result?: T): void {
  if (state.completing) return;
  state.completing = true;
  state.error = error;
  state.result = result;
  clearTimeout(state.requestTimer);
  if (state.closed) {
    settle(state);
    return;
  }
  try {
    state.child.stdin.end();
  } catch {
    state.error = new Error(`${state.protocol.source} could not close the quota request.`);
  }
  signalChild(state, "SIGTERM");
  state.terminationTimer = setTimeout(() => {
    signalChild(state, "SIGKILL");
    state.killTimer = setTimeout(() => cleanupExpired(state), KILL_GRACE_MS);
  }, TERMINATION_GRACE_MS);
}

function settle<T>(state: QuotaProcessState<T>): void {
  clearTimeout(state.requestTimer);
  clearTimeout(state.terminationTimer);
  clearTimeout(state.killTimer);
  state.release();
  if (state.error !== undefined) state.reject(state.error);
  else if (state.result !== undefined) state.resolve(state.result);
  else state.reject(new Error(`${state.protocol.source} returned no usage response.`));
}

function cleanupExpired<T>(state: QuotaProcessState<T>): void {
  // Pipe owners outside the direct child must not keep the request pending.
  state.child.stdin.destroy();
  state.child.stdout.destroy();
  state.child.stderr.destroy();
  state.error = new Error(`${state.protocol.source} quota process cleanup did not complete.`);
  if (state.child.exitCode !== null || state.child.signalCode !== null) settle(state);
  // Retain guards/listeners until unresolved ownership ends, even after reporting failure.
  else state.reject(state.error);
}

function writeMessage<T>(state: QuotaProcessState<T>, message: unknown): void {
  if (state.completing) return;
  try {
    state.child.stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    finish(state, new Error(`${state.protocol.source} could not write the quota request.`));
  }
}

function readStdout<T>(state: QuotaProcessState<T>, chunk: string): void {
  if (!acceptOutput(state, chunk)) return;
  try {
    const result = state.protocol.stdout(chunk, (message) => writeMessage(state, message));
    if (result !== undefined) finish(state, undefined, result);
  } catch (error) {
    finish(state, error instanceof Error ? error : new Error("Malformed quota response."));
  }
}

function acceptOutput<T>(state: QuotaProcessState<T>, chunk: string): boolean {
  if (state.completing) return false;
  state.bytes += Buffer.byteLength(chunk);
  if (state.bytes <= OUTPUT_LIMIT_BYTES) return true;
  finish(state, new Error(`${state.protocol.source} quota output exceeded the safety limit.`));
  return false;
}

function closeProcess<T>(state: QuotaProcessState<T>, code: number | null): void {
  state.closed = true;
  if (state.completing) {
    settle(state);
    return;
  }
  if (state.protocol.close === undefined) {
    finish(
      state,
      new Error(
        `${state.protocol.source} exited before returning usage limits; check native authentication.`,
      ),
    );
    return;
  }
  try {
    finish(state, undefined, state.protocol.close(code));
  } catch (error) {
    finish(state, error instanceof Error ? error : new Error("Quota request failed."));
  }
}
