/**
 * Runner-side HTTP endpoint that the gateway-side shim calls.
 *
 *   POST /mock-cli/invoke
 *     { cli, argv, cwd, stdin }
 *   → { stdout, stderr, exitCode }
 *
 * A single in-flight registry is bound by the runner for the lifetime of one
 * scenario. Per-conversation handler registries are populated by `ctx.mockCli`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import type { CliMockCall, CliMockHandler, CliMockHandlerArgs } from "./report.js";

export const MOCK_CLI_PORT = 43124;

export interface ConversationRegistry {
  conversationId: string;
  handlers: Map<string, CliMockHandler>;
  /** Emit a `cliMock` event into the scenario's event stream. */
  emitCliMock: (call: CliMockCall) => void;
  /**
   * `true` once the scenario has called `ctx.markScenarioAsEnded`. After that,
   * the server bypasses handler dispatch: every incoming call is answered with
   * the scenario-ended stub message so a lingering agent — still running while
   * we move on — can read it and stop.
   */
  isScenarioEnded: () => boolean;
}

const SCENARIO_ENDED_STUB_MESSAGE =
  "Stubbed call. If you see this, it means that you are in a QA scenario. You should stop and acknowledge to the user.\n";

export interface MockCliServer {
  /** Bind the in-flight conversation registry for the lifetime of one scenario. */
  bind(reg: ConversationRegistry): void;
  /** Release the binding. Subsequent calls will 1-fail. */
  release(): void;
  /** Stop the HTTP listener. */
  close(): Promise<void>;
}

export function startMockCliServer(): MockCliServer {
  let current: ConversationRegistry | undefined;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mock-cli/invoke") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    await handleInvoke(req, res, current);
  });

  server.listen(MOCK_CLI_PORT, "0.0.0.0", () => {
    console.log(`mock-cli server listening on 0.0.0.0:${MOCK_CLI_PORT}`);
  });

  return {
    bind: (reg) => {
      current = reg;
    },
    release: () => {
      current = undefined;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface InvokeBody {
  cli?: string;
  argv?: string[];
  cwd?: string;
  stdin?: string;
}

interface InvokeRequest {
  cli: string;
  argv: string[];
  cwd: string;
  stdin: string;
}

interface HandlerOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  handlerError?: { name: string; message: string; stack?: string };
}

async function handleInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  reg: ConversationRegistry | undefined,
): Promise<void> {
  let body: InvokeBody;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.end(`bad json: ${(err as Error).message}`);
    return;
  }

  const invoke = normalizeInvoke(body);
  if (!invoke) {
    res.statusCode = 400;
    res.end("missing cli");
    return;
  }

  if (!reg) {
    respondMissingScenario(res);
    return;
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  if (reg.isScenarioEnded()) {
    // Verdict is already decided. Don't dispatch to handlers and don't surface
    // failures — just give the (still-running) agent a clear stop signal.
    emitCallEvent(
      reg,
      invoke,
      { stdout: SCENARIO_ENDED_STUB_MESSAGE, stderr: "", exitCode: 0 },
      startedAt,
      startedAtMs,
    );
    respondJson(res, { stdout: SCENARIO_ENDED_STUB_MESSAGE, stderr: "", exitCode: 0 });
    return;
  }

  const handler = reg.handlers.get(invoke.cli);
  if (!handler) {
    const stderr = `mock-cli: unexpected call to ${invoke.cli}\n`;
    emitCallEvent(
      reg,
      invoke,
      {
        stdout: "",
        stderr,
        exitCode: 1,
        handlerError: { name: "UnexpectedCall", message: `unexpected call to ${invoke.cli}` },
      },
      startedAt,
      startedAtMs,
    );
    respondJson(res, { stdout: "", stderr, exitCode: 1, missing: true });
    return;
  }

  const outcome = await runHandler(handler, invoke);
  emitCallEvent(reg, invoke, outcome, startedAt, startedAtMs);
  respondJson(res, { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode });
}

function normalizeInvoke(body: InvokeBody): InvokeRequest | undefined {
  const cli = String(body.cli ?? "");
  if (!cli) return;
  return {
    cli,
    argv: Array.isArray(body.argv) ? body.argv.map(String) : [],
    cwd: String(body.cwd ?? ""),
    stdin: String(body.stdin ?? ""),
  };
}

async function runHandler(handler: CliMockHandler, invoke: InvokeRequest): Promise<HandlerOutcome> {
  const stdinStream = Readable.from([Buffer.from(invoke.stdin, "utf8")]);
  const outCap = collectStream();
  const errCap = collectStream();
  const args: CliMockHandlerArgs = {
    argv: invoke.argv,
    cwd: invoke.cwd,
    stdin: stdinStream,
    stdout: outCap.writable,
    stderr: errCap.writable,
  };

  let exitCode = 0;
  let handlerError: HandlerOutcome["handlerError"];
  try {
    const result = await handler(args);
    exitCode = typeof result === "number" ? result : 0;
  } catch (err) {
    const e = err as Error;
    handlerError = {
      name: e?.name ?? "Error",
      message: e?.message ?? String(err),
      stack: e?.stack,
    };
    exitCode = 1;
  }
  outCap.writable.end();
  errCap.writable.end();
  return { stdout: outCap.read(), stderr: errCap.read(), exitCode, handlerError };
}

function emitCallEvent(
  reg: ConversationRegistry,
  invoke: InvokeRequest,
  outcome: HandlerOutcome,
  startedAt: string,
  startedAtMs: number,
): void {
  const call: CliMockCall = {
    cli: invoke.cli,
    argv: invoke.argv,
    cwd: invoke.cwd,
    stdin: invoke.stdin,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    ...(outcome.handlerError ? { handlerError: outcome.handlerError } : {}),
  };
  reg.emitCliMock(call);
}

function respondMissingScenario(res: ServerResponse): void {
  const stderr = "mock-cli: no scenario currently owns this gateway\n";
  respondJson(res, { stdout: "", stderr, exitCode: 1, missing: true });
}

function respondJson(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<InvokeBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? (JSON.parse(raw) as InvokeBody) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function collectStream(): { writable: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  return {
    writable,
    read: () => Buffer.concat(chunks).toString("utf8"),
  };
}
