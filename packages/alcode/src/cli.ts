import { readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";

import { createAgentAdapter, type CodingAgent, resolveCodingAgent } from "./coding-agent.js";
import { renderGuide } from "./guide.js";
import { type ExecutableModelResolver, resolveExecutableModel, resolveModels } from "./models.js";
import {
  assertPlansGate,
  applyCompletion,
  listSessionRecords,
  resolveSessionFilePath,
  type SessionFrontmatter,
  type SessionRecord,
  writeInitialSessionFile,
} from "./session-file.js";
import { buildPrompt, PROTOCOLS } from "./prompt.js";
import { buildAgentEnv, type RunConfig, type RunOutput, runAgent } from "./run-agent.js";

// Distinct from 1 (ordinary run failure) so a script can branch on an auth failure that needs an
// operator re-login rather than a retry.
const EXIT_AUTH_REQUIRED = 2;

export interface MainOptions {
  argv?: string[];
  stdout?: RunOutput;
  stderr?: RunOutput;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  modelResolver?: ExecutableModelResolver;
}

export async function main(options?: MainOptions): Promise<number> {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;

  let parsed: AlcodeArgs;
  try {
    parsed = parseAlcodeArgs(argv);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (parsed.version) {
    stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  let agent: CodingAgent;
  try {
    agent = resolveCodingAgent(env);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const models = resolveModels(agent, env);
  if (parsed.help) {
    stdout.write(renderHelp(agent, models));
    return 0;
  }
  if (parsed.guide || parsed.openclawGuide) {
    stdout.write(`${renderGuide(parsed.openclawGuide ? "openclaw" : "generic", agent, models)}\n`);
    return 0;
  }

  const validationError = validateArgs(parsed, models);
  if (validationError) {
    stderr.write(`${validationError}\n`);
    return 1;
  }

  return runSession(parsed, agent, {
    cwd,
    env,
    stdout,
    stderr,
    modelResolver: options?.modelResolver ?? resolveExecutableModel,
  });
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (!pkg.version) throw new Error("alcode: package.json is missing 'version'");
  return pkg.version;
}

interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: RunOutput;
  stderr: RunOutput;
  modelResolver: ExecutableModelResolver;
}

// alcode always runs the selected coding agent in the foreground and blocks until it exits. When
// OpenClaw drives alcode, it wraps this call in its own `exec` tool (which backgrounds and wakes
// the agent on exit) — alcode owns no backgrounding or callback of its own. The per-run session
// file under `.plans/` is the durable result handoff: on completion the frontmatter carries the
// session id and status, and the `---- Result ----` block carries the outcome for a waking agent
// (or a human).
async function runSession(
  parsed: AlcodeArgs,
  agent: CodingAgent,
  ctx: RunContext,
): Promise<number> {
  const { cwd, env, stdout, stderr, modelResolver } = ctx;

  const gateError = assertPlansGate(cwd);
  if (gateError) {
    stderr.write(`${gateError}\n`);
    return 1;
  }

  const realCwd = realpathSync(cwd);
  const records = listSessionRecords(cwd);
  const guardError = checkLaunchGuards(parsed, agent, realCwd, records);
  if (guardError) {
    stderr.write(`${guardError}\n`);
    return 1;
  }

  const now = new Date();
  const ticket = resolveTicket(parsed, records);
  const sessionFilePath = resolveSessionFilePath(cwd, ticket, now);
  writeInitialSessionFile(sessionFilePath, buildFrontmatter(parsed, agent, now, realCwd, ticket));
  stdout.write(`Session file: ${relative(cwd, sessionFilePath)}\n\n`);

  let executableModel: string | undefined;
  try {
    executableModel = await modelResolver(agent, parsed.model, {
      cwd,
      env: buildAgentEnv(env, (env.ALIGNFIRST_CODE_UNSET ?? "").split(",")),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    applyCompletion(sessionFilePath, {
      status: "failed",
      endedAt: new Date().toISOString(),
      exitReason: "error",
      sessionId: null,
      result: message,
    });
    stderr.write(`${message}\n`);
    return 1;
  }

  const result = await runAgent(
    buildRunConfig(parsed, cwd, sessionFilePath, env, executableModel),
    createAgentAdapter(agent),
    stdout,
  );

  if (parsed.isNew && result.sessionId) {
    stdout.write(`\nSession ID: ${result.sessionId}\n`);
  }
  if (result.authRequired) {
    stderr.write(
      "alcode: coding agent not authenticated — an administrator must re-login on the host " +
        `${agent === "claude" ? "(`claude`, then `/login`)" : "(`codex login`)"}.\n`,
    );
    return EXIT_AUTH_REQUIRED;
  }
  return result.status === "succeeded" ? 0 : 1;
}

// Fail-fast launch guards, run against the (healed) session records before anything is written.
// Returns the error to print, or `undefined` when the launch may proceed.
export function checkLaunchGuards(
  parsed: AlcodeArgs,
  agent: CodingAgent,
  realCwd: string,
  records: SessionRecord[],
): string | undefined {
  if (parsed.resume !== undefined) {
    // A resumed run writes a new session file carrying the same sessionId as the original, so one
    // id can match several records — a running status on any of them blocks.
    const matches = records.filter((r) => r.frontmatter.sessionId === parsed.resume);
    if (matches.length === 0) return unknownResumeError(parsed.resume, records);
    const running = matches.find((r) => r.frontmatter.status === "running");
    if (running) {
      return (
        `Error: session ${parsed.resume} is still running (pid ${running.frontmatter.pid}); ` +
        "wait for it to finish or kill it."
      );
    }
    const latest = [...matches].sort((a, b) =>
      b.frontmatter.startedAt.localeCompare(a.frontmatter.startedAt),
    )[0];
    if (latest.frontmatter.agent === null) {
      return (
        `Error: session ${parsed.resume} predates agent-aware sessions and cannot be resumed; ` +
        "start a new session."
      );
    }
    if (latest.frontmatter.agent !== agent) {
      return (
        `Error: session ${parsed.resume} belongs to agent ${latest.frontmatter.agent}, but the ` +
        `selected agent is ${agent}.`
      );
    }
  }
  // Protocol runs only: plain messages (answers, questions, plan executions) may run at any time.
  if (parsed.protocol !== undefined) {
    const busy = records.find(
      (r) => r.frontmatter.status === "running" && r.frontmatter.cwd === realCwd,
    );
    if (busy) {
      return (
        `Error: a protocol run is already active in this worktree (${busy.path}, ` +
        `pid ${busy.frontmatter.pid}); one protocol run at a time per worktree.`
      );
    }
  }
  return;
}

function unknownResumeError(resume: string, records: SessionRecord[]): string {
  if (records.length === 0) {
    return `Error: unknown session id ${resume}; no session records exist under .plans/.`;
  }
  const recent = [...records]
    .sort((a, b) => b.frontmatter.startedAt.localeCompare(a.frontmatter.startedAt))
    .slice(0, 5)
    .map(({ frontmatter: f }) => {
      return `  ${f.sessionId ?? "(no id)"}  ${f.status}  ${f.startedAt}  ticket ${f.ticket ?? "-"}`;
    });
  return `Error: unknown session id ${resume}. Known recent sessions:\n${recent.join("\n")}`;
}

// The effective ticket scopes the session file to `.plans/<ticket>/_alcode/` and lands in the
// frontmatter. Exported for tests. Precedence: explicit `--ticket`, then the resumed session's
// records, then a `.plans/<ticket>/` path in the message.
export function resolveTicket(parsed: AlcodeArgs, records: SessionRecord[]): string | undefined {
  if (parsed.ticket !== undefined) return parsed.ticket;
  if (parsed.resume !== undefined) return inheritTicketFromResume(parsed.resume, records);
  if (parsed.isNew && parsed.message !== undefined) return inferTicketFromMessage(parsed.message);
  return;
}

// Latest record of the resumed session that carries a ticket — the resumed run keeps writing
// under the same ticket directory, and its frontmatter keeps the ticket for later resumes.
function inheritTicketFromResume(resume: string, records: SessionRecord[]): string | undefined {
  const ticketed = records.filter(
    (r) => r.frontmatter.sessionId === resume && r.frontmatter.ticket !== null,
  );
  const latest = ticketed.sort((a, b) =>
    b.frontmatter.startedAt.localeCompare(a.frontmatter.startedAt),
  )[0];
  return latest?.frontmatter.ticket ?? undefined;
}

// A message like `Execute the plan: .plans/2/B2-plan.md` names its ticket. `_`-prefixed segments
// (e.g. `_alcode`) are not tickets; several distinct candidates mean the message is ambiguous.
function inferTicketFromMessage(message: string): string | undefined {
  const candidates = new Set<string>();
  for (const match of message.matchAll(/\.plans\/([A-Za-z0-9._-]+)\//g)) {
    const segment = match[1];
    if (!segment.startsWith("_") && isPathSafeTicket(segment)) candidates.add(segment);
  }
  if (candidates.size !== 1) return;
  return [...candidates][0];
}

function buildFrontmatter(
  parsed: AlcodeArgs,
  agent: CodingAgent,
  now: Date,
  realCwd: string,
  ticket: string | undefined,
): SessionFrontmatter {
  return {
    status: "running",
    agent,
    protocol: parsed.protocol ?? null,
    ticket: ticket ?? null,
    model: parsed.model ?? null,
    sessionId: null,
    command: formatCommand(parsed),
    meta: parsed.meta ?? null,
    pid: process.pid,
    cwd: realCwd,
    startedAt: now.toISOString(),
    endedAt: null,
    exitReason: null,
  };
}

export function buildRunConfig(
  parsed: AlcodeArgs,
  cwd: string,
  sessionFilePath: string,
  env: NodeJS.ProcessEnv,
  executableModel: string | undefined,
): RunConfig {
  return {
    prompt: buildPrompt(parsed),
    sessionFilePath,
    cwd,
    isNew: parsed.isNew,
    resume: parsed.resume,
    executableModel,
    skipPermissions: env.ALIGNFIRST_CODE_SKIP_PERMISSIONS === "1",
    unset: (env.ALIGNFIRST_CODE_UNSET ?? "").split(","),
    env,
  };
}

function formatCommand(parsed: AlcodeArgs): string {
  const parts = ["alcode"];
  if (parsed.isNew) parts.push("--new");
  if (parsed.resume) parts.push("--resume", parsed.resume);
  if (parsed.protocol) parts.push("--protocol", parsed.protocol);
  if (parsed.ticket) parts.push("--ticket", parsed.ticket);
  if (parsed.model) parts.push("--model", parsed.model);
  if (parsed.message) parts.push("--message", JSON.stringify(parsed.message));
  if (parsed.meta) parts.push("--meta", JSON.stringify(parsed.meta));
  return parts.join(" ");
}

// --- Argument parsing + validation (ported from the retired .mjs) ---

export interface AlcodeArgs {
  isNew: boolean;
  resume?: string;
  ticket?: string;
  protocol?: string;
  message?: string;
  model?: string;
  meta?: string;
  guide: boolean;
  openclawGuide: boolean;
  help: boolean;
  version: boolean;
}

export function parseAlcodeArgs(argv: string[]): AlcodeArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      new: { type: "boolean", default: false },
      resume: { type: "string" },
      ticket: { type: "string" },
      protocol: { type: "string" },
      message: { type: "string" },
      model: { type: "string" },
      meta: { type: "string" },
      guide: { type: "boolean", default: false },
      "openclaw-guide": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
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
    meta: values.meta,
    guide: values.guide === true,
    openclawGuide: values["openclaw-guide"] === true,
    help: values.help === true,
    version: values.version === true,
  };
}

export function validateArgs(args: AlcodeArgs, models: readonly string[]): string | undefined {
  const isResume = args.resume !== undefined;
  if (args.isNew && isResume) return "Error: --new and --resume are mutually exclusive.";
  if (!args.isNew && !isResume) return "Error: at least one of --new or --resume is required.";
  if (args.protocol !== undefined && !(PROTOCOLS as readonly string[]).includes(args.protocol)) {
    return `Error: --protocol must be one of: ${PROTOCOLS.join(", ")}.`;
  }
  if (args.model !== undefined && !models.includes(args.model)) {
    return `Error: --model must be one of: ${models.join(", ")}.`;
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
  if (args.ticket !== undefined && !isPathSafeTicket(args.ticket)) {
    return (
      "Error: --ticket must be a single path segment " +
      "(letters, digits, '.', '-', '_'); no path separators or '..'."
    );
  }
  return;
}

// The ticket becomes a `.plans/<ticket>/_alcode/…` path segment. Ticket formats vary by
// consumer repo (numeric here, but e.g. `AB-123` elsewhere), so allow a permissive charset while
// blocking path separators and `..` traversal that could escape `.plans/`.
function isPathSafeTicket(ticket: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(ticket) && ticket !== "." && !ticket.includes("..");
}

function renderHelp(agent: CodingAgent, models: readonly string[]): string {
  const permissionMode =
    agent === "claude"
      ? "--permission-mode auto (dangerous opt-out: --dangerously-skip-permissions)"
      : "--sandbox workspace-write (dangerous opt-out: --dangerously-bypass-approvals-and-sandbox)";
  const modelBehavior =
    agent === "codex"
      ? "Codex aliases sol, terra, and luna resolve on demand; configured full slugs pass through."
      : "Claude model values pass through unchanged.";
  return `alcode — run a coding agent through AlignFirst protocols.

Usage:
  alcode --new --protocol <protocol> --ticket <id> [--message "..."]
  alcode --new --message "..."
  alcode --resume <sessionId> [--protocol <protocol>] [--message "..."]
  alcode --guide
  alcode --openclaw-guide
  alcode --help
  alcode -v, --version

Modes:
  --new                 Start a new session.
  --resume <sessionId>  Continue an existing session.

Options:
  --protocol <p>    One of: ${PROTOCOLS.join(", ")}.
  --ticket <id>     Ticket ID. Required with --new + --protocol.
  --message "..."   Message to send. Required for spec, aad, and when no --protocol.
  --model <model>   Model for a new session: one of ${models.join(", ")}. Omit to use the
                    default model.
  --meta "..."      Opaque handoff string, stored verbatim in the session file frontmatter
                    (\`meta:\`). alcode never interprets it; a later reader of the session file
                    (e.g. the caller reporting the run's outcome) can use it.

Env:
  ALIGNFIRST_CODE_AGENT            Required coding agent: claude or codex (selected: ${agent}).
  ALIGNFIRST_CODE_MODELS           Comma-list overriding the models accepted by --model.
  ALIGNFIRST_CODE_SKIP_PERMISSIONS 1 to run the coding agent with permission prompts disabled.
  ALIGNFIRST_CODE_UNSET            Comma-list of env vars to strip from the coding agent child.

Selected-agent permissions: ${permissionMode}
${modelBehavior}

alcode runs a coding agent in the foreground and blocks until it finishes, streaming the
transcript to stdout and to a session file under .plans/. Coding runs can be very long: always
run alcode as a background task. Your platform does the backgrounding; never detach alcode.

Run \`alcode --guide\` for the full delegation guide (\`alcode --openclaw-guide\` under OpenClaw).
`;
}
