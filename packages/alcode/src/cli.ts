import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_ALIGNFIRST_COMMAND, reserveSideTicket } from "./alignfirst-cli.js";
import { type CodingAgent, createAgentAdapter, resolveCodingAgent } from "./coding-agent.js";
import { type GuideVariant, renderGuide } from "./guide.js";
import { type ExecutableModelResolver, resolveExecutableModel, resolveModels } from "./models.js";
import { buildPrompt, PROTOCOLS } from "./prompt.js";
import { buildAgentEnv, runAgent, type RunConfig, type RunOutput } from "./run-agent.js";
import {
  applyCompletion,
  assertPlansGate,
  listSessionRecords,
  readPidStartTime,
  reconcileSessionFile,
  resolveSessionFilePath,
  type SessionFrontmatter,
  type SessionRecord,
  writeInitialSessionFile,
} from "./session-file.js";
import { readUsage, type UsageReader } from "./usage.js";

// Distinct from 1 (ordinary run failure) so a script can branch on an auth failure that needs an
// operator re-login rather than a retry.
const EXIT_AUTH_REQUIRED = 2;

const SESSION_OPTIONS = {
  protocol: { type: "string" },
  ticket: { type: "string" },
  message: { type: "string", short: "m" },
  model: { type: "string" },
  meta: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

export interface MainOptions {
  argv?: string[];
  stdout?: RunOutput;
  stderr?: RunOutput;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  alignfirstCommand?: string[];
  modelResolver?: ExecutableModelResolver;
  usageReader?: UsageReader;
}

export type AlcodeCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "guide"; variant: GuideVariant }
  | { kind: "status"; sessionFile: string }
  | { kind: "usage" }
  | { kind: "session"; args: SessionArgs };

// `resume` undefined means a new session.
export interface SessionArgs {
  resume?: string;
  ticket?: string;
  noTicket: boolean;
  protocol?: string;
  message?: string;
  model?: string;
  meta?: string;
}

export async function main(options?: MainOptions): Promise<number> {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const alignfirstCommand = options?.alignfirstCommand ?? DEFAULT_ALIGNFIRST_COMMAND;

  let command: AlcodeCommand;
  try {
    command = parseAlcodeArgs(argv);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (command.kind === "version") {
    stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (command.kind === "status") {
    try {
      const sessionFilePath = resolveStatusSessionFile(cwd, command.sessionFile);
      const completion = reconcileSessionFile(sessionFilePath);
      stdout.write(renderSessionStatus(cwd, sessionFilePath, completion.frontmatter));
      return 0;
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  let agent: CodingAgent;
  try {
    agent = resolveCodingAgent(env);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (command.kind === "usage") {
    try {
      const report = await (options?.usageReader ?? readUsage)(agent, { cwd, env });
      stdout.write(`${report.trimEnd()}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const models = resolveModels(agent, env);
  if (command.kind === "help") {
    stdout.write(renderHelp(agent, models));
    return 0;
  }
  if (command.kind === "guide") {
    stdout.write(`${renderGuide(command.variant, agent, models)}\n`);
    return 0;
  }

  const validationError = validateSessionArgs(command.args, models);
  if (validationError) {
    stderr.write(`${validationError}\n`);
    return 1;
  }

  return runSession(command.args, agent, {
    cwd,
    env,
    stdout,
    stderr,
    alignfirstCommand,
    modelResolver: options?.modelResolver ?? resolveExecutableModel,
  });
}

function resolveStatusSessionFile(cwd: string, input: string): string {
  const sessionFilePath = resolve(cwd, input);
  const plansPath = resolve(cwd, ".plans");
  if (
    !isWithinDirectory(plansPath, sessionFilePath) ||
    basename(dirname(sessionFilePath)) !== "_alcode" ||
    extname(sessionFilePath) !== ".md"
  ) {
    throw new Error("Error: status requires a session file under .plans/**/_alcode/*.md.");
  }
  if (!existsSync(sessionFilePath)) {
    throw new Error(`Error: session file not found: ${relative(cwd, sessionFilePath)}`);
  }
  if (!isWithinDirectory(realpathSync(plansPath), realpathSync(sessionFilePath))) {
    throw new Error("Error: the session file resolves outside the current project's .plans/.");
  }
  return sessionFilePath;
}

function isWithinDirectory(directory: string, path: string): boolean {
  const childPath = relative(directory, path);
  return (
    childPath !== "" &&
    childPath !== ".." &&
    !childPath.startsWith(`..${sep}`) &&
    !isAbsolute(childPath)
  );
}

function renderSessionStatus(
  cwd: string,
  sessionFilePath: string,
  frontmatter: SessionFrontmatter,
): string {
  return [
    `sessionFile: ${relative(cwd, sessionFilePath)}`,
    `sessionId: ${frontmatter.sessionId ?? ""}`,
    `status: ${frontmatter.status}`,
    `pid: ${frontmatter.pid ?? ""}`,
    `startedAt: ${frontmatter.startedAt}`,
    `endedAt: ${frontmatter.endedAt ?? ""}`,
    `exitReason: ${frontmatter.exitReason ?? ""}`,
    "",
  ].join("\n");
}

export function parseAlcodeArgs(argv: string[]): AlcodeCommand {
  const [command, ...tokens] = argv.slice(2);
  switch (command) {
    case undefined:
      throw new Error("Error: no command given. Run `alcode --help`.");
    case "--help":
    case "-h":
      return { kind: "help" };
    case "--version":
    case "-v":
      return { kind: "version" };
    case "--guide":
      return { kind: "guide", variant: "generic" };
    case "--openclaw-guide":
      return { kind: "guide", variant: "openclaw" };
    case "new":
      return parseNewCommand(tokens);
    case "resume":
      return parseResumeCommand(tokens);
    case "status":
      return parseStatusCommand(tokens);
    case "usage":
      return parseBareCommand(tokens, "usage");
    default:
      throw new Error(`Error: unknown command "${command}". Run \`alcode --help\`.`);
  }
}

function parseStatusCommand(tokens: string[]): AlcodeCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { help: { type: "boolean", short: "h", default: false } },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return { kind: "help" };
  if (positionals.length !== 1) {
    throw new Error("Error: `alcode status` takes exactly one <session-file>.");
  }
  return { kind: "status", sessionFile: positionals[0] };
}

function parseNewCommand(tokens: string[]): AlcodeCommand {
  const { values } = parseArgs({
    args: tokens,
    options: { ...SESSION_OPTIONS, "no-ticket": { type: "boolean", default: false } },
    strict: true,
  });
  if (values.help) return { kind: "help" };
  return {
    kind: "session",
    args: {
      ticket: values.ticket,
      noTicket: values["no-ticket"],
      protocol: values.protocol,
      message: values.message,
      model: values.model,
      meta: values.meta,
    },
  };
}

function parseResumeCommand(tokens: string[]): AlcodeCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: SESSION_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return { kind: "help" };
  if (positionals.length !== 1) {
    throw new Error("Error: `alcode resume` takes exactly one <sessionId>.");
  }
  return {
    kind: "session",
    args: {
      resume: positionals[0],
      ticket: values.ticket,
      noTicket: false,
      protocol: values.protocol,
      message: values.message,
      model: values.model,
      meta: values.meta,
    },
  };
}

function parseBareCommand(tokens: string[], kind: "usage"): AlcodeCommand {
  const { values } = parseArgs({
    args: tokens,
    options: { help: { type: "boolean", short: "h", default: false } },
    strict: true,
  });
  return values.help ? { kind: "help" } : { kind };
}

export function validateSessionArgs(
  args: SessionArgs,
  models: readonly string[],
): string | undefined {
  const isNew = args.resume === undefined;
  const hasMessage = args.message !== undefined && args.message.trim() !== "";
  if (args.protocol !== undefined && !(PROTOCOLS as readonly string[]).includes(args.protocol)) {
    return `Error: --protocol must be one of: ${PROTOCOLS.join(", ")}.`;
  }
  if (args.model !== undefined && !models.includes(args.model)) {
    return `Error: --model must be one of: ${models.join(", ")}.`;
  }
  if (args.protocol === undefined && !hasMessage) {
    return "Error: --message is required when --protocol is not specified.";
  }
  if (args.ticket !== undefined && args.noTicket) {
    return "Error: --ticket and --no-ticket are mutually exclusive.";
  }
  if (args.noTicket && args.protocol === undefined) {
    return "Error: --no-ticket requires --protocol.";
  }
  if (isNew && args.protocol !== undefined && args.ticket === undefined && !args.noTicket) {
    return "Error: --ticket or --no-ticket is required with `new --protocol`.";
  }
  if (["spec", "aad"].includes(args.protocol ?? "") && !hasMessage) {
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

interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: RunOutput;
  stderr: RunOutput;
  alignfirstCommand: string[];
  modelResolver: ExecutableModelResolver;
}

// alcode always runs the selected coding agent in the foreground and blocks until it exits. When
// OpenClaw drives alcode, it wraps this call in its own `exec` tool (which backgrounds and wakes
// the agent on exit) — alcode owns no backgrounding or callback of its own. The per-run session
// file under `.plans/` is the durable result handoff: on completion the frontmatter carries the
// session id and status, and the `---- Result ----` block carries the outcome for a waking agent
// (or a human).
async function runSession(args: SessionArgs, agent: CodingAgent, ctx: RunContext): Promise<number> {
  const { cwd, env, stdout, stderr, alignfirstCommand, modelResolver } = ctx;

  const gateError = assertPlansGate(cwd);
  if (gateError) {
    stderr.write(`${gateError}\n`);
    return 1;
  }

  const realCwd = realpathSync(cwd);
  const records = listSessionRecords(cwd);
  const guardError = checkLaunchGuards(args, agent, realCwd, records);
  if (guardError) {
    stderr.write(`${guardError}\n`);
    return 1;
  }

  const now = new Date();
  let ticket: string | undefined;
  try {
    ticket = args.noTicket
      ? reserveSideTicket(alignfirstCommand, cwd)
      : resolveTicket(args, records);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const sessionFilePath = resolveSessionFilePath(cwd, ticket, now);
  writeInitialSessionFile(sessionFilePath, buildFrontmatter(args, agent, now, realCwd, ticket));
  stdout.write(`Session file: ${relative(cwd, sessionFilePath)}\n\n`);

  let executableModel: string | undefined;
  try {
    executableModel = await modelResolver(agent, args.model, {
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
    buildRunConfig(args, ticket, cwd, sessionFilePath, env, executableModel),
    createAgentAdapter(agent),
    stdout,
  );

  if (args.resume === undefined && result.sessionId) {
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
  args: SessionArgs,
  agent: CodingAgent,
  realCwd: string,
  records: SessionRecord[],
): string | undefined {
  if (args.resume !== undefined) {
    // A resumed run writes a new session file carrying the same sessionId as the original, so one
    // id can match several records — a running status on any of them blocks.
    const matches = records.filter((r) => r.frontmatter.sessionId === args.resume);
    if (matches.length === 0) return unknownResumeError(args.resume, records);
    const running = matches.find((r) => r.frontmatter.status === "running");
    if (running) {
      return (
        `Error: session ${args.resume} is still running (pid ${running.frontmatter.pid}); ` +
        "wait for it to finish or kill it."
      );
    }
    const latest = [...matches].sort((a, b) =>
      b.frontmatter.startedAt.localeCompare(a.frontmatter.startedAt),
    )[0];
    if (latest.frontmatter.agent === null) {
      return (
        `Error: session ${args.resume} predates agent-aware sessions and cannot be resumed; ` +
        "start a new session."
      );
    }
    if (latest.frontmatter.agent !== agent) {
      return (
        `Error: session ${args.resume} belongs to agent ${latest.frontmatter.agent}, but the ` +
        `selected agent is ${agent}.`
      );
    }
  }
  // Protocol runs only: plain messages (answers, questions, plan executions) may run at any time.
  if (args.protocol !== undefined) {
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

// The effective ticket scopes the session file to `.plans/<ticket>/_alcode/`, lands in the
// frontmatter, and reaches the agent in the prompt. Exported for tests. Precedence: explicit
// `--ticket`, then the resumed session's records, then a `.plans/<ticket>/` path in the message.
export function resolveTicket(args: SessionArgs, records: SessionRecord[]): string | undefined {
  if (args.ticket !== undefined) return args.ticket;
  if (args.resume !== undefined) return inheritTicketFromResume(args.resume, records);
  if (args.message !== undefined) return inferTicketFromMessage(args.message);
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
  args: SessionArgs,
  agent: CodingAgent,
  now: Date,
  realCwd: string,
  ticket: string | undefined,
): SessionFrontmatter {
  return {
    status: "running",
    agent,
    protocol: args.protocol ?? null,
    ticket: ticket ?? null,
    model: args.model ?? null,
    sessionId: null,
    command: formatCommand(args),
    meta: args.meta ?? null,
    pid: process.pid,
    pidStartTime: readPidStartTime(process.pid),
    cwd: realCwd,
    startedAt: now.toISOString(),
    endedAt: null,
    exitReason: null,
  };
}

function formatCommand(args: SessionArgs): string {
  const parts = ["alcode", ...(args.resume === undefined ? ["new"] : ["resume", args.resume])];
  if (args.protocol !== undefined) parts.push("--protocol", args.protocol);
  if (args.ticket !== undefined) parts.push("--ticket", args.ticket);
  if (args.noTicket) parts.push("--no-ticket");
  if (args.model !== undefined) parts.push("--model", args.model);
  if (args.message !== undefined) parts.push("--message", JSON.stringify(args.message));
  if (args.meta !== undefined) parts.push("--meta", JSON.stringify(args.meta));
  return parts.join(" ");
}

export function buildRunConfig(
  args: SessionArgs,
  ticket: string | undefined,
  cwd: string,
  sessionFilePath: string,
  env: NodeJS.ProcessEnv,
  executableModel: string | undefined,
): RunConfig {
  return {
    prompt: buildPrompt({ protocol: args.protocol, ticket, message: args.message }),
    sessionFilePath,
    cwd,
    resume: args.resume,
    executableModel,
    skipPermissions: env.ALIGNFIRST_CODE_SKIP_PERMISSIONS === "1",
    unset: (env.ALIGNFIRST_CODE_UNSET ?? "").split(","),
    env,
  };
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (!pkg.version) throw new Error("alcode: package.json is missing 'version'");
  return pkg.version;
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
  alcode new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
  alcode new --message "..."
  alcode resume <sessionId> [--protocol <protocol>] [--message "..."]
  alcode status <session-file>
  alcode usage
  alcode --guide
  alcode --openclaw-guide
  alcode -h, --help
  alcode -v, --version

Commands:
  new                   Start a new session; prints its Session ID at the end.
  resume <sessionId>    Continue an existing session.
  status <session-file> Reconcile and show one run's durable status. Does not start an agent.
  usage                 Show the selected coding agent's current usage limits and reset times.

Options (new, resume):
  --protocol <p>        One of: ${PROTOCOLS.join(", ")}.
  --ticket <id>         Ticket ID. \`new --protocol\` requires it, or --no-ticket.
  --no-ticket           Work without a ticket: reserves the next side ticket through
                        \`alignfirst ticket --side\` and passes it to the agent. new only,
                        requires --protocol.
  -m, --message "..."   Message to send. Required for spec, aad, and when no --protocol.
  --model <model>       Model for a new session: one of ${models.join(", ")}. Omit to use the
                        default model.
  --meta "..."          Opaque handoff string, stored verbatim in the session file frontmatter
                        (\`meta:\`). alcode never interprets it; a later reader of the session file
                        (e.g. the caller reporting the run's outcome) can use it.

Requires: the alignfirst CLI on PATH (npm install -g alignfirst), for side tickets and the
delegated protocols.

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
