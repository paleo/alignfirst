import { relative } from "node:path";
import { parseArgs } from "node:util";

import { type ForegroundParams, runForeground, type Writer } from "./foreground.js";
import { renderGuide } from "./guide.js";
import {
  assertPlansGate,
  type LogFrontmatter,
  resolveLogPath,
  writeInitialLog,
} from "./log-file.js";
import { isModeError, resolveMode } from "./mode.js";
import { spawnDetachedNode } from "./process-utils.js";
import { buildPrompt, PROTOCOLS } from "./prompt.js";
import { RUN_CONFIG_ENV, type RunConfig, runSessionEntryPath } from "./run-session.js";

export interface MainOptions {
  argv?: string[];
  stdout?: Writer;
  stderr?: Writer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function main(options?: MainOptions): Promise<number> {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;

  let parsed: AlcoachArgs;
  try {
    parsed = parseAlcoachArgs(argv);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (parsed.help) {
    stdout.write(renderHelp());
    return 0;
  }
  if (parsed.guide) {
    stdout.write(`${renderGuide()}\n`);
    return 0;
  }

  const validationError = validateArgs(parsed);
  if (validationError) {
    stderr.write(`${validationError}\n`);
    return 1;
  }

  return runCoaching(parsed, { cwd, env, stdout, stderr });
}

interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Writer;
  stderr: Writer;
}

async function runCoaching(parsed: AlcoachArgs, ctx: RunContext): Promise<number> {
  const { cwd, env, stdout, stderr } = ctx;

  const gateError = assertPlansGate(cwd);
  if (gateError) {
    stderr.write(`${gateError}\n`);
    return 1;
  }

  const mode = resolveMode({ callbackUrl: parsed.callbackUrl, sessionKey: parsed.sessionKey }, env);
  if (isModeError(mode)) {
    stderr.write(`${mode.error}\n`);
    return 1;
  }

  const now = new Date();
  const logPath = resolveLogPath(cwd, parsed.ticket, now);
  writeInitialLog(logPath, buildFrontmatter(parsed, now));

  const runConfig = buildRunConfig(parsed, cwd, logPath, mode.isBackground, mode.callback, env);
  const childEnv: NodeJS.ProcessEnv = { ...env, [RUN_CONFIG_ENV]: JSON.stringify(runConfig) };
  const childPid = spawnDetachedNode(runSessionEntryPath(), childEnv, cwd);
  const relativePath = relative(cwd, logPath);

  if (mode.isBackground) {
    stdout.write(`Started. Log: ${relativePath}\n`);
    if (parsed.isNew) {
      stdout.write("The claude session id lands in the log frontmatter on completion.\n");
    }
    return 0;
  }

  const foreground: ForegroundParams = {
    logPath,
    childPid,
    isNew: parsed.isNew,
    stdout,
  };
  return runForeground(foreground);
}

function buildFrontmatter(parsed: AlcoachArgs, now: Date): LogFrontmatter {
  return {
    status: "running",
    protocol: parsed.protocol ?? null,
    ticket: parsed.ticket ?? null,
    model: parsed.model ?? null,
    sessionId: null,
    command: formatCommand(parsed),
    startedAt: now.toISOString(),
    endedAt: null,
    exitReason: null,
  };
}

function buildRunConfig(
  parsed: AlcoachArgs,
  cwd: string,
  logPath: string,
  isBackground: boolean,
  callback: RunConfig["callback"],
  env: NodeJS.ProcessEnv,
): RunConfig {
  return {
    prompt: buildPrompt(parsed),
    logPath,
    cwd,
    isNew: parsed.isNew,
    isBackground,
    resume: parsed.resume,
    model: parsed.model,
    skipPermissions: env.ALCOACH_SKIP_PERMISSIONS === "1",
    unset: (env.ALCOACH_UNSET ?? "").split(","),
    callback,
  };
}

function formatCommand(parsed: AlcoachArgs): string {
  const parts = ["alcoach"];
  if (parsed.isNew) parts.push("--new");
  if (parsed.resume) parts.push("--resume", parsed.resume);
  if (parsed.protocol) parts.push("--protocol", parsed.protocol);
  if (parsed.ticket) parts.push("--ticket", parsed.ticket);
  if (parsed.model) parts.push("--model", parsed.model);
  if (parsed.message) parts.push("--message", JSON.stringify(parsed.message));
  return parts.join(" ");
}

// --- Argument parsing + validation (ported from the retired .mjs) ---

export interface AlcoachArgs {
  isNew: boolean;
  resume?: string;
  ticket?: string;
  protocol?: string;
  message?: string;
  model?: string;
  sessionKey?: string;
  callbackUrl?: string;
  guide: boolean;
  help: boolean;
}

export function parseAlcoachArgs(argv: string[]): AlcoachArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      new: { type: "boolean", default: false },
      resume: { type: "string" },
      ticket: { type: "string" },
      protocol: { type: "string" },
      message: { type: "string" },
      model: { type: "string" },
      "session-key": { type: "string" },
      "callback-url": { type: "string" },
      guide: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return {
    isNew: values.new === true,
    resume: values.resume,
    ticket: values.ticket,
    protocol: values.protocol,
    message: values.message,
    model: values.model,
    sessionKey: values["session-key"],
    callbackUrl: values["callback-url"],
    guide: values.guide === true,
    help: values.help === true,
  };
}

export function validateArgs(args: AlcoachArgs): string | undefined {
  const isResume = args.resume !== undefined;
  if (args.isNew && isResume) return "Error: --new and --resume are mutually exclusive.";
  if (!args.isNew && !isResume) return "Error: at least one of --new or --resume is required.";
  if (args.protocol !== undefined && !(PROTOCOLS as readonly string[]).includes(args.protocol)) {
    return `Error: --protocol must be one of: ${PROTOCOLS.join(", ")}.`;
  }
  if (!args.protocol && !args.message) {
    return "Error: --message is required when --protocol is not specified.";
  }
  if (args.isNew && args.protocol && !args.ticket) {
    return "Error: --ticket is required with --new and --protocol.";
  }
  if (["spec", "aad"].includes(args.protocol ?? "") && !args.message) {
    return `Error: --protocol ${args.protocol} requires --message.`;
  }
  if (args.ticket !== undefined && !args.isNew) {
    return "Error: --ticket is only valid with --new.";
  }
  return;
}

function renderHelp(): string {
  return `alcoach — coach a coding agent through AlignFirst protocols.

Usage:
  alcoach --new --protocol <protocol> --ticket <id> [--message "..."]
  alcoach --new --message "..."
  alcoach --resume <sessionId> [--protocol <protocol>] [--message "..."]
  alcoach --guide
  alcoach --help

Modes:
  --new                 Start a new session.
  --resume <sessionId>  Continue an existing session.

Options:
  --protocol <p>    One of: ${PROTOCOLS.join(", ")}.
  --ticket <id>     Ticket ID. Required with --new + --protocol.
  --message "..."   Message to send. Required for spec, aad, and when no --protocol.
  --model <model>   Model override.
  --session-key <k> Callback target for OpenClaw (from the session_status tool).
  --callback-url <u> Override ALCOACH_CALLBACK_URL.

Env:
  ALCOACH_CALLBACK_URL     Callback endpoint; its presence selects background mode.
  ALCOACH_CALLBACK_TOKEN   Bearer token for the callback.
  ALCOACH_SKIP_PERMISSIONS 1 to pass --dangerously-skip-permissions to claude.
  ALCOACH_UNSET            Comma-list of env vars to strip from the claude child.

Run \`alcoach --guide\` for the full coaching guide.
`;
}
