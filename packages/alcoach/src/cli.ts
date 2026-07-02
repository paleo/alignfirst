import { relative } from "node:path";
import { parseArgs } from "node:util";

import { renderGuide } from "./guide.js";
import {
  assertPlansGate,
  type LogFrontmatter,
  resolveLogPath,
  writeInitialLog,
} from "./log-file.js";
import { buildPrompt, PROTOCOLS } from "./prompt.js";
import { type RunConfig, type RunOutput, runClaude } from "./run-claude.js";

export interface MainOptions {
  argv?: string[];
  stdout?: RunOutput;
  stderr?: RunOutput;
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
  stdout: RunOutput;
  stderr: RunOutput;
}

// alcoach always runs `claude` in the foreground and blocks until it exits. When OpenClaw drives
// alcoach, it wraps this call in its own `exec` tool (which backgrounds after `yieldMs` and wakes
// the agent on exit) — alcoach owns no backgrounding or callback of its own. The per-run log under
// `.plans/` is the durable result handoff: on completion the frontmatter carries the session id and
// status, and the `---- Result ----` block carries the outcome for a waking agent (or a human).
async function runCoaching(parsed: AlcoachArgs, ctx: RunContext): Promise<number> {
  const { cwd, env, stdout, stderr } = ctx;

  const gateError = assertPlansGate(cwd);
  if (gateError) {
    stderr.write(`${gateError}\n`);
    return 1;
  }

  const now = new Date();
  const logPath = resolveLogPath(cwd, parsed.ticket, now);
  writeInitialLog(logPath, buildFrontmatter(parsed, now));
  stdout.write(`Log: ${relative(cwd, logPath)}\n\n`);

  const result = await runClaude(buildRunConfig(parsed, cwd, logPath, env), stdout);

  if (parsed.isNew && result.sessionId) {
    stdout.write(`\nSession ID: ${result.sessionId}\n`);
  }
  return result.status === "succeeded" ? 0 : 1;
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
  env: NodeJS.ProcessEnv,
): RunConfig {
  return {
    prompt: buildPrompt(parsed),
    logPath,
    cwd,
    isNew: parsed.isNew,
    resume: parsed.resume,
    model: parsed.model,
    skipPermissions: env.ALIGNFIRST_COACH_SKIP_PERMISSIONS === "1",
    unset: (env.ALIGNFIRST_COACH_UNSET ?? "").split(","),
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

Env:
  ALIGNFIRST_COACH_SKIP_PERMISSIONS 1 to pass --dangerously-skip-permissions to claude.
  ALIGNFIRST_COACH_UNSET            Comma-list of env vars to strip from the claude child.

alcoach runs claude in the foreground and blocks until it finishes, streaming the transcript to
stdout and to a log under .plans/. To run it as a background task, let your caller (e.g. OpenClaw's
exec tool) do the backgrounding; do not detach alcoach yourself.

Run \`alcoach --guide\` for the full coaching guide.
`;
}
