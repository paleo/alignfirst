import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { loadCatchup, loadContext, reserveSideTicket } from "../alignfirst-cli.js";
import { type AldevConfig, type CodeConfig, requireCodeConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import type { Output } from "../output.js";
import {
  companionInUse,
  type ItemName,
  type ProjectReport,
  readProjectReport,
} from "../project/layout.js";
import { type CodingAgent, createAgentAdapter } from "./coding-agent.js";
import { type ExecutableModelResolver, resolveModels } from "./models.js";
import { buildPrompt, PROTOCOLS } from "./prompt.js";
import type { QuotaReader } from "./quota.js";
import { buildAgentEnv, runAgent, type RunConfig } from "./run-agent.js";
import {
  applyCompletion,
  findNewestSessionFile,
  listSessionRecords,
  readPidStartTime,
  reconcileSessionFile,
  resolveSessionFilePath,
  type SessionFrontmatter,
  type SessionRecord,
  writeInitialSessionFile,
} from "./session-file.js";

// Distinct from 1 (ordinary run failure) so a script can branch on an auth failure that needs an
// operator re-login rather than a retry.
const EXIT_AUTH_REQUIRED = 2;

const SESSION_OPTIONS = {
  protocol: { type: "string" },
  catchup: { type: "boolean", default: false },
  "message-file": { type: "string" },
  ticket: { type: "string" },
  message: { type: "string", short: "m" },
  model: { type: "string" },
  meta: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

// Items whose companion copy the coder may edit: the companion becomes a writable directory.
const WRITABLE_COMPANION_ITEMS: readonly ItemName[] = [
  ".alignfirst.json",
  ".alignfirst.md",
  "DEVELOPERS.md",
  "docs",
  ".plans",
];

// Items the coder would not find in the repository: a new session gets `alignfirst context`.
const CONTEXT_COMPANION_ITEMS: readonly ItemName[] = [
  ".alignfirst.json",
  ".alignfirst.md",
  "docs",
  ".plans",
];

const TICKET_PATH_ERROR =
  "Error: --ticket must be a single path segment " +
  "(letters, digits, '.', '-', '_'); no path separators or '..'.";

export interface CodeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Output;
  stderr: Output;
  alignfirstCommand: string[];
  modelResolver: ExecutableModelResolver;
  quotaReader: QuotaReader;
}

// Where the working directory's session files and work files live.
interface SessionTree {
  // Real path of the working directory, the base of the printed paths.
  cwd: string;
  // The `.plans`-shaped directory holding the `_aldev/` session directories.
  sessionsDir: string;
  plansDir: string;
}

export type CodeCommand =
  | { kind: "help" }
  | { kind: "status"; target: StatusTarget }
  | { kind: "quota" }
  | { kind: "session"; args: SessionArgs };

export type StatusTarget =
  | { kind: "file"; sessionFile: string }
  | { kind: "ticket"; ticket: string }
  | { kind: "noTicket" }
  | { kind: "meta"; meta: string };

// `resume` undefined means a new session.
export interface SessionArgs {
  resume?: string;
  ticket?: string;
  noTicket: boolean;
  protocol?: string;
  catchup?: boolean;
  messageFile?: string;
  message?: string;
  model?: string;
  meta?: string;
}

export async function runCode(
  tokens: string[],
  config: AldevConfig,
  ctx: CodeContext,
): Promise<number> {
  try {
    const command = parseCodeArgs(tokens);
    if (command.kind === "status") return showStatus(ctx, command.target);
    const code = requireCodeConfig(config);
    if (command.kind === "quota") return await showQuota(ctx, code);
    const models = resolveModels(code.agent, code.models);
    if (command.kind === "help") {
      ctx.stdout.write(renderHelp(code.agent, models));
      return 0;
    }
    loadMessage(command.args, ctx.cwd);
    const validationError = validateSessionArgs(command.args, models);
    if (validationError) {
      ctx.stderr.write(`${validationError}\n`);
      return 1;
    }
    return await runSession(command.args, code, ctx);
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function showStatus(ctx: CodeContext, target: StatusTarget): number {
  const tree = sessionTreeOf(readReport(ctx), ctx.cwd);
  const sessionFilePath = resolveStatusTargetSessionFile(tree, target);
  const completion = reconcileSessionFile(sessionFilePath);
  ctx.stdout.write(renderSessionStatus(tree.cwd, sessionFilePath, completion.frontmatter));
  return 0;
}

function readReport(ctx: CodeContext): ProjectReport {
  const report = readProjectReport(ctx.alignfirstCommand, ctx.cwd, ctx.env);
  if ("error" in report) throw new Error(report.error);
  return report;
}

function sessionTreeOf(report: ProjectReport, cwd: string): SessionTree {
  return {
    cwd: realpathSync(cwd),
    sessionsDir: report.locations._aldev.path,
    plansDir: report.locations[".plans"].path,
  };
}

async function showQuota(ctx: CodeContext, code: CodeConfig): Promise<number> {
  const report = await ctx.quotaReader(code.agent, {
    cwd: ctx.cwd,
    env: ctx.env,
    unset: code.unset,
  });
  ctx.stdout.write(`${report.trimEnd()}\n`);
  return 0;
}

function resolveStatusTargetSessionFile(tree: SessionTree, target: StatusTarget): string {
  if (target.kind === "file") return resolveStatusSessionFile(tree, target.sessionFile);
  if (target.kind === "meta") return resolveMetaSessionFile(tree, target.meta);
  const dir = join(
    tree.sessionsDir,
    ...(target.kind === "ticket" ? [target.ticket] : []),
    "_aldev",
  );
  const sessionFilePath = findNewestSessionFile(dir);
  if (sessionFilePath === undefined) {
    throw new Error(`Error: no session file under ${displayPath(tree.cwd, dir)}/.`);
  }
  return resolveStatusSessionFile(tree, sessionFilePath);
}

// A run tagged with `--meta <key>` is found by that key alone: the session tree is shared across
// worktrees, so its newest run may belong to another thread.
function resolveMetaSessionFile(tree: SessionTree, meta: string): string {
  const matches = listSessionRecords(tree.sessionsDir, tree.plansDir).filter(
    (record) => record.frontmatter.meta === meta,
  );
  if (matches.length === 0) throw new Error(`Error: no session file with meta "${meta}".`);
  const newest = matches.reduce((a, b) =>
    a.frontmatter.startedAt >= b.frontmatter.startedAt ? a : b,
  );
  return resolveStatusSessionFile(tree, newest.path);
}

function loadMessage(args: SessionArgs, cwd: string): void {
  if (args.messageFile === undefined) return;
  if (args.message !== undefined) {
    throw new Error("Error: --message and --message-file are mutually exclusive.");
  }
  args.message = readFileSync(
    args.messageFile === "-" ? 0 : resolve(cwd, args.messageFile),
    "utf8",
  );
}

function resolveStatusSessionFile(tree: SessionTree, input: string): string {
  const sessionFilePath = resolve(tree.cwd, input);
  const sessionsDir = displayPath(tree.cwd, tree.sessionsDir);
  if (!isSessionFilePath(tree.sessionsDir, sessionFilePath)) {
    throw new Error(
      `Error: status requires a session file under ${sessionsDir}/_aldev/ or ` +
        `${sessionsDir}/<ticket>/_aldev/.`,
    );
  }
  if (!existsSync(sessionFilePath)) {
    throw new Error(`Error: session file not found: ${displayPath(tree.cwd, sessionFilePath)}`);
  }
  if (!isSessionFilePath(realpathSync(tree.sessionsDir), realpathSync(sessionFilePath))) {
    throw new Error(`Error: the session file resolves outside ${sessionsDir}/.`);
  }
  return sessionFilePath;
}

// `_aldev/<name>.md` or `<ticket>/_aldev/<name>.md`, relative to the sessions directory.
function isSessionFilePath(sessionsDir: string, path: string): boolean {
  const childPath = relative(sessionsDir, path);
  if (isAbsolute(childPath) || extname(path) !== ".md") return false;
  const segments = childPath.split(sep);
  if (segments.length === 2) return segments[0] === "_aldev";
  return segments.length === 3 && segments[0] !== ".." && segments[1] === "_aldev";
}

// Relative to the working directory when inside it, absolute otherwise.
function displayPath(cwd: string, path: string): string {
  const childPath = relative(cwd, path);
  if (
    childPath === "" ||
    childPath === ".." ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    return path;
  }
  return childPath;
}

function renderSessionStatus(
  cwd: string,
  sessionFilePath: string,
  frontmatter: SessionFrontmatter,
): string {
  return [
    `sessionFile: ${displayPath(cwd, sessionFilePath)}`,
    `sessionId: ${frontmatter.sessionId ?? ""}`,
    `status: ${frontmatter.status}`,
    `pid: ${frontmatter.pid ?? ""}`,
    `startedAt: ${frontmatter.startedAt}`,
    `endedAt: ${frontmatter.endedAt ?? ""}`,
    `exitReason: ${frontmatter.exitReason ?? ""}`,
    `contextTokens: ${frontmatter.contextTokens ?? ""}`,
    `contextCompacted: ${frontmatter.contextCompacted}`,
    `contextTokensError: ${frontmatter.contextTokensError ?? ""}`,
    `meta: ${frontmatter.meta ?? ""}`,
    "",
  ].join("\n");
}

export function parseCodeArgs(tokens: string[]): CodeCommand {
  const [command, ...rest] = tokens;
  switch (command) {
    case undefined:
      throw new Error("Error: no command given. Run `aldev code --help`.");
    case "--help":
    case "-h":
      return { kind: "help" };
    case "new":
      return parseNewCommand(rest);
    case "resume":
      return parseResumeCommand(rest);
    case "status":
      return parseStatusCommand(rest);
    case "quota":
      return parseBareCommand(rest, "quota");
    default:
      throw new Error(`Error: unknown command "${command}". Run \`aldev code --help\`.`);
  }
}

function parseStatusCommand(tokens: string[]): CodeCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      ticket: { type: "string" },
      "no-ticket": { type: "boolean", default: false },
      meta: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return { kind: "help" };
  const targetCount =
    positionals.length +
    Number(values.ticket !== undefined) +
    Number(values["no-ticket"]) +
    Number(values.meta !== undefined);
  if (targetCount !== 1) {
    throw new Error(
      "Error: `aldev code status` takes exactly one of <session-file>, --ticket <id>, --no-ticket " +
        "or --meta <key>.",
    );
  }
  if (values.meta !== undefined)
    return { kind: "status", target: { kind: "meta", meta: values.meta } };
  if (values.ticket !== undefined) {
    if (!isPathSafeTicket(values.ticket)) throw new Error(TICKET_PATH_ERROR);
    return { kind: "status", target: { kind: "ticket", ticket: values.ticket } };
  }
  if (values["no-ticket"]) return { kind: "status", target: { kind: "noTicket" } };
  return { kind: "status", target: { kind: "file", sessionFile: positionals[0] } };
}

function parseNewCommand(tokens: string[]): CodeCommand {
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
      catchup: values.catchup,
      messageFile: values["message-file"],
      message: values.message,
      model: values.model,
      meta: values.meta,
    },
  };
}

function parseResumeCommand(tokens: string[]): CodeCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: SESSION_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return { kind: "help" };
  if (positionals.length !== 1) {
    throw new Error("Error: `aldev code resume` takes exactly one <sessionId>.");
  }
  return {
    kind: "session",
    args: {
      resume: positionals[0],
      ticket: values.ticket,
      noTicket: false,
      protocol: values.protocol,
      catchup: values.catchup,
      messageFile: values["message-file"],
      message: values.message,
      model: values.model,
      meta: values.meta,
    },
  };
}

function parseBareCommand(tokens: string[], kind: "quota"): CodeCommand {
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
  if (args.protocol === undefined && !hasMessage && args.catchup !== true) {
    return "Error: --message is required when --protocol is not specified.";
  }
  if (!isNew && args.catchup === true) {
    return "Error: --catchup is for `new` only; a resumed session already holds the history.";
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
    return TICKET_PATH_ERROR;
  }
  return;
}

// The ticket becomes a `.plans/<ticket>/_aldev/…` path segment. Ticket formats vary by
// consumer repo (numeric here, but e.g. `AB-123` elsewhere), so allow a permissive charset while
// blocking path separators and `..` traversal that could escape `.plans/`.
function isPathSafeTicket(ticket: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(ticket) && ticket !== "." && !ticket.includes("..");
}

// `aldev code` always runs the selected coding agent in the foreground and blocks until it exits.
// When OpenClaw drives it, it wraps this call in its own `exec` tool (which backgrounds and wakes
// the assistant on exit) — aldev owns no backgrounding or callback of its own. The per-run session
// file is the durable result handoff: on completion the frontmatter carries the session id and
// status, and the `---- Result ----` block carries the outcome for a waking caller (or a human).
async function runSession(args: SessionArgs, code: CodeConfig, ctx: CodeContext): Promise<number> {
  const { cwd, env, stdout, stderr, alignfirstCommand, modelResolver } = ctx;
  const { agent } = code;

  const report = readReport(ctx);
  const tree = sessionTreeOf(report, cwd);
  const plans = report.locations[".plans"];
  if (!plans.exists) {
    stderr.write(
      `Error: no .plans/ directory at ${displayPath(tree.cwd, plans.path)}. ` +
        "Create it, or run `alignfirst plans setup <clone>`.\n",
    );
    return 1;
  }

  const records = listSessionRecords(tree.sessionsDir, tree.plansDir);
  const guardError = checkLaunchGuards(args, agent, tree.cwd, records);
  if (guardError) {
    stderr.write(`${guardError}\n`);
    return 1;
  }

  const now = new Date();
  const ticket = args.noTicket
    ? reserveSideTicket(alignfirstCommand, cwd, env)
    : resolveTicket(args, records);
  let catchupContent: string | undefined;
  if (args.catchup === true) {
    if (ticket === undefined) {
      throw new Error("Error: --catchup requires a resolved ticket; provide --ticket <id>.");
    }
    catchupContent = loadCatchup(alignfirstCommand, cwd, ticket, env);
  }
  const contextContent =
    args.resume === undefined && companionInUse(report, CONTEXT_COMPANION_ITEMS)
      ? loadContext(alignfirstCommand, cwd, env)
      : undefined;
  const sessionFilePath = resolveSessionFilePath(tree.sessionsDir, ticket, now);
  writeInitialSessionFile(sessionFilePath, buildFrontmatter(args, agent, now, tree.cwd, ticket));
  stdout.write(`Session file: ${displayPath(tree.cwd, sessionFilePath)}\n\n`);

  let executableModel: string | undefined;
  try {
    executableModel = await modelResolver(agent, args.model, {
      cwd,
      env: buildAgentEnv(env, code.unset),
    });
  } catch (error) {
    const message = errorMessage(error);
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
    buildRunConfig({
      args,
      code,
      report,
      ticket,
      cwd,
      sessionFilePath,
      env,
      executableModel,
      catchupContent,
      contextContent,
    }),
    createAgentAdapter(agent),
    stdout,
  );

  if (args.resume === undefined && result.sessionId) {
    stdout.write(`\nSession ID: ${result.sessionId}\n`);
  }
  if (result.authRequired) {
    stderr.write(
      "aldev code: coding agent not authenticated — an administrator must re-login on the host " +
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
    return `Error: unknown session id ${resume}; no session records exist.`;
  }
  const recent = [...records]
    .sort((a, b) => b.frontmatter.startedAt.localeCompare(a.frontmatter.startedAt))
    .slice(0, 5)
    .map(({ frontmatter: f }) => {
      return `  ${f.sessionId ?? "(no id)"}  ${f.status}  ${f.startedAt}  ticket ${f.ticket ?? "-"}`;
    });
  return `Error: unknown session id ${resume}. Known recent sessions:\n${recent.join("\n")}`;
}

// The effective ticket scopes the session file to `<ticket>/_aldev/`, lands in the
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
// (e.g. `_aldev`) are not tickets; several distinct candidates mean the message is ambiguous.
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
    contextTokens: null,
    contextCompacted: false,
    contextTokensError: null,
  };
}

function formatCommand(args: SessionArgs): string {
  const parts = [
    "aldev",
    "code",
    ...(args.resume === undefined ? ["new"] : ["resume", args.resume]),
  ];
  if (args.protocol !== undefined) parts.push("--protocol", args.protocol);
  if (args.ticket !== undefined) parts.push("--ticket", args.ticket);
  if (args.noTicket) parts.push("--no-ticket");
  if (args.catchup === true) parts.push("--catchup");
  if (args.model !== undefined) parts.push("--model", args.model);
  if (args.messageFile !== undefined) {
    parts.push("--message-file", JSON.stringify(args.messageFile));
  } else if (args.message !== undefined) {
    parts.push("--message", JSON.stringify(args.message));
  }
  if (args.meta !== undefined) parts.push("--meta", JSON.stringify(args.meta));
  return parts.join(" ");
}

export interface RunInput {
  args: SessionArgs;
  code: CodeConfig;
  report: ProjectReport;
  ticket: string | undefined;
  cwd: string;
  sessionFilePath: string;
  env: NodeJS.ProcessEnv;
  executableModel: string | undefined;
  catchupContent?: string;
  contextContent?: string;
}

export function buildRunConfig(input: RunInput): RunConfig {
  const { args, code, report } = input;
  return {
    prompt: buildPrompt({
      protocol: args.protocol,
      ticket: input.ticket,
      message: args.message,
      catchupContent: input.catchupContent,
      contextContent: input.contextContent,
    }),
    sessionFilePath: input.sessionFilePath,
    cwd: input.cwd,
    resume: args.resume,
    executableModel: input.executableModel,
    skipPermissions: code.skipPermissions,
    additionalDirectories:
      !code.skipPermissions &&
      report.companion !== null &&
      companionInUse(report, WRITABLE_COMPANION_ITEMS)
        ? [report.companion.dir]
        : [],
    unset: code.unset,
    env: input.env,
  };
}

function renderHelp(agent: CodingAgent, models: readonly string[]): string {
  const permissionMode =
    agent === "claude"
      ? "--permission-mode auto (dangerous opt-out: --dangerously-skip-permissions)"
      : "--sandbox workspace-write (dangerous opt-out: --dangerously-bypass-approvals-and-sandbox)";
  const modelBehavior =
    agent === "codex"
      ? "Codex aliases astra, sol, terra, and luna resolve on demand; configured full slugs pass through."
      : "Claude model values pass through unchanged.";
  return `aldev code — run a coding agent through AlignFirst protocols.

Usage:
  aldev code new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
  aldev code new --catchup --ticket <id> [--protocol <protocol>] [--message-file <path|->]
  aldev code new --message "..."
  aldev code resume <sessionId> [--protocol <protocol>] [--message "..."]
  aldev code status (<session-file> | --ticket <id> | --no-ticket | --meta <key>)
  aldev code quota
  aldev code -h, --help

Commands:
  new                   Start a new session; prints its Session ID at the end.
  resume <sessionId>    Continue an existing session.
  status                Reconcile and show one run's durable status: the given file, or the newest
                        run of the ticket, of no-ticket work, or of the --meta key. Includes
                        contextTokens, the context-window occupancy the run ended on, and
                        contextCompacted. Does not start an agent.
  quota                 Show the selected coding agent's account limits and reset times.

Options (status):
  --ticket <id>         Newest run of that ticket.
  --no-ticket           Newest run of no-ticket work.
  --meta <key>          Newest run tagged with \`--meta <key>\`, wherever it sits.

Options (new, resume):
  --protocol <p>        One of: ${PROTOCOLS.join(", ")}.
  --ticket <id>         Ticket ID. \`new --protocol\` requires it or a side ticket through
                        --no-ticket.
  --no-ticket           Side ticket, for work without a ticket: reserves the next one through
                        \`alignfirst ticket --side\` and passes it to the agent. new only,
                        requires --protocol.
  --catchup             Load the ticket history before the message. new only.
  -m, --message "..."   Message to send. Required for spec/aad, or without protocol/catchup.
  --message-file <path> Read the message from a UTF-8 file, or stdin with -. Exclusive with -m.
  --model <model>       Model for a new session: one of ${models.join(", ")}. Omit to use the
                        default model.
  --meta "..."          Opaque handoff string, stored verbatim in the session file frontmatter
                        (\`meta:\`). aldev never interprets it; a later reader of the session file
                        (e.g. the caller reporting the run's outcome) can use it.

Requires: the alignfirst CLI on PATH (npm install -g alignfirst), for the project layout, side
tickets and the delegated protocols.

Config (~/.config/alignfirst/aldev.config.json):
  code.agent            Required coding agent: claude or codex (selected: ${agent}).
  code.models           List replacing the models accepted by --model.
  code.skipPermissions  true to run the coding agent with permission prompts disabled.
  code.unset            Env vars to strip from the coding agent child.

Selected-agent permissions: ${permissionMode}
The normal mode also makes the project's companion directory writable when it is in use.
${modelBehavior}

aldev code runs a coding agent in the foreground and blocks until it finishes, streaming the
transcript to stdout and to a session file under .plans/ or its companion. Coding runs can be
very long: always run aldev code as a background task. Your platform does the backgrounding;
never detach it.

Run \`aldev guide code\` for the full delegation guide.
`;
}
