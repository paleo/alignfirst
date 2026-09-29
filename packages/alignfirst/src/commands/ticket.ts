import { join } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { displayPath, formatLocalTimestamp, formatSize } from "../format.js";
import { parseCommandArgs } from "../parse-args.js";
import { renderCatchup } from "../plans/catchup.js";
import { assertPlansGate } from "../plans/layout.js";
import {
  detectTicketFromBranch,
  deduceTicketFromExisting,
  nextFilePosition,
  peekSideTicket,
  reserveSideTicket,
  resolveTicketDir,
  type ResolvedTicketDir,
  type TicketEntry,
  validateTicketId,
} from "../plans/ticket.js";
import { layoutOf } from "../project-layout.js";

const USAGE = `Usage:
  {{FORM}} ticket [<id>] [--next [<filename>]] [--new-cycle] [--json] [--dry-run]
  {{FORM}} ticket --side [--next [<filename>]] [--new-cycle] [--json] [--dry-run]
  {{FORM}} ticket [<id>] --catchup

--next may repeat, each occurrence with a filename: the names are numbered in order.

--catchup prints the ticket's Markdown files, plans excluded, summaries included.
Files over 64 KiB are listed without content. Above 30 KiB of output, only the entry
list is printed.
`;

interface TicketOptions {
  id: string;
  branch?: string;
  next?: NextRequest;
  newCycle: boolean;
  json: boolean;
  dryRun: boolean;
  side: boolean;
  catchup: boolean;
}

/** `true` asks for the bare FILE_PREFIX; filenames ask for one FILE_NAME each, in order. */
type NextRequest = string[] | true;

interface TicketJsonReport {
  TICKET_ID: string;
  TICKET_DIR: string;
  state: ResolvedTicketDir["state"];
  branch?: string;
  entries: TicketJsonEntry[];
}

interface TicketJsonEntry {
  name: string;
  size?: number;
  modifiedAt: string;
}

export function runTicket(ctx: CommandContext, args: string[]): number {
  const usage = renderUsage(ctx);
  const parsed = parseTicketArgs(ctx, args, usage);
  if (parsed === undefined) return 0;
  const plans = layoutOf(ctx).locations[".plans"];
  assertPlansGate(plans, ctx.form);
  const result = resolveTicket(plans.path, parsed);
  if (parsed.catchup) {
    ctx.stdout.write(renderCatchup(ctx.cwd, result, renderReport(ctx, parsed, result)));
    return 0;
  }
  if (parsed.next !== undefined) {
    writeNextReport(ctx, parsed, result, parsed.next);
    return 0;
  }
  if (parsed.json)
    ctx.stdout.write(`${JSON.stringify(jsonReport(ctx, parsed, result), undefined, 2)}\n`);
  else ctx.stdout.write(renderReport(ctx, parsed, result));
  return 0;
}

function renderUsage(ctx: CommandContext): string {
  return USAGE.replaceAll("{{FORM}}", ctx.form);
}

function parseTicketArgs(
  ctx: CommandContext,
  args: string[],
  usage: string,
): TicketOptions | undefined {
  const normalized = normalizeNextArgs(args);
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args: normalized.args,
      options: {
        next: { type: "boolean" },
        "new-cycle": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        side: { type: "boolean", default: false },
        catchup: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (positionals.length > 1) throw new CliError(`Expected at most one ticket id.\n\n${usage}`);
  if (values.side && positionals.length > 0)
    throw new CliError(`A ticket id cannot be combined with --side.\n\n${usage}`);
  if (values["new-cycle"] && values.next === undefined)
    throw new CliError(`--new-cycle requires --next.\n\n${usage}`);
  if (
    values.catchup &&
    (values.side || values.next !== undefined || values.json || values["dry-run"])
  )
    throw new CliError(
      `--catchup cannot be combined with --side, --next, --json, or --dry-run.\n\n${usage}`,
    );
  const next =
    values.next === undefined ? undefined : resolveNextRequest(normalized.requests, usage);
  const resolution = resolveTicketId(ctx, positionals[0], values);
  return {
    ...resolution,
    next,
    newCycle: values["new-cycle"],
    json: values.json,
    dryRun: values["dry-run"],
    side: values.side,
    catchup: values.catchup,
  };
}

interface NormalizedNextArgs {
  args: string[];
  /** One entry per `--next` occurrence: its filename, or `undefined` for the bare form. */
  requests: (string | undefined)[];
}

function normalizeNextArgs(args: string[]): NormalizedNextArgs {
  const normalized: NormalizedNextArgs = { args: [], requests: [] };
  for (let index = 0; index < args.length; ++index) {
    const arg = args[index];
    if (arg === "--") {
      normalized.args.push(...args.slice(index));
      break;
    }
    if (arg.startsWith("--next=")) {
      normalized.requests.push(arg.slice("--next=".length));
      normalized.args.push("--next");
      continue;
    }
    normalized.args.push(arg);
    if (arg !== "--next") continue;
    const following = args[index + 1];
    if (following !== undefined && !following.startsWith("-")) {
      normalized.requests.push(following);
      ++index;
    } else normalized.requests.push(undefined);
  }
  return normalized;
}

function resolveNextRequest(requests: (string | undefined)[], usage: string): NextRequest {
  if (requests.length === 1 && requests[0] === undefined) return true;
  const filenames = requests.filter((request) => request !== undefined);
  if (filenames.length < requests.length)
    throw new CliError(`A repeated --next requires a filename on each occurrence.\n\n${usage}`);
  for (const filename of filenames) validateNextFilename(filename);
  return filenames;
}

function validateNextFilename(filename: string): void {
  if (filename.length === 0 || filename === "." || filename === ".." || /[\\/]/u.test(filename)) {
    throw new CliError("--next must be a non-empty single path segment.");
  }
}

interface TicketResolution {
  id: string;
  branch?: string;
}

interface TicketFlags {
  side: boolean;
  "dry-run": boolean;
  catchup: boolean;
}

function resolveTicketId(
  ctx: CommandContext,
  positional: string | undefined,
  flags: TicketFlags,
): TicketResolution {
  const pattern = ctx.projectConfig?.config.ticketIdPattern;
  if (positional !== undefined) {
    validateTicketId(positional);
    return { id: positional };
  }
  const plans = layoutOf(ctx).locations[".plans"];
  if (flags.side) {
    assertPlansGate(plans, ctx.form);
    return { id: flags["dry-run"] ? peekSideTicket(plans.path) : reserveSideTicket(plans.path) };
  }
  const template = ctx.projectConfig?.config.git?.branchNameTemplate;
  const detection = detectTicketFromBranch(ctx.cwd, pattern, template);
  if (detection.kind === "detected") {
    validateTicketId(detection.id);
    return detection;
  }
  if (pattern === undefined)
    return deduceTicketFromExisting(ctx.cwd, plans.path, { sideAllowed: !flags.catchup });
  if (detection.kind === "noBranch")
    throw new CliError("Cannot deduce a ticket id from a detached HEAD.");
  const templateDetail = template?.includes("{TICKET_ID}") ? ` and template "${template}"` : "";
  throw new CliError(
    `Cannot deduce a ticket id from branch "${detection.branch}" with pattern "${pattern}"${templateDetail}.`,
  );
}

function resolveTicket(plansPath: string, options: TicketOptions): ResolvedTicketDir {
  if (options.side && !options.dryRun)
    return { id: options.id, dir: join(plansPath, options.id), state: "created", entries: [] };
  return resolveTicketDir(plansPath, options.id, { dryRun: options.dryRun });
}

function writeNextReport(
  ctx: CommandContext,
  options: TicketOptions,
  result: ResolvedTicketDir,
  request: NextRequest,
): void {
  const names = result.entries.map((entry) => entry.name);
  const { cycleLetter, fileNumber } = nextFilePosition(names, options.newCycle);
  const fileName = (filename: string, offset: number) =>
    `${cycleLetter}${fileNumber + offset}-${filename}`;
  const report = {
    TICKET_DIR: `${displayPath(ctx.cwd, result.dir)}/`,
    CYCLE_LETTER: cycleLetter,
    ...(request === true
      ? { FILE_NUMBER: fileNumber, FILE_PREFIX: `${cycleLetter}${fileNumber}` }
      : request.length === 1
        ? { FILE_NUMBER: fileNumber, FILE_NAME: fileName(request[0], 0) }
        : { FILE_NAMES: request.map(fileName) }),
  };
  if (options.json) {
    ctx.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    return;
  }
  const lines = Object.entries(report).map(([name, value]) =>
    Array.isArray(value)
      ? [`- ${name}:`, ...value.map((item) => `  - \`${item}\``)].join("\n")
      : `- ${name}: \`${value}\``,
  );
  ctx.stdout.write(`${lines.join("\n")}\n`);
}

function jsonReport(
  ctx: CommandContext,
  options: TicketOptions,
  result: ResolvedTicketDir,
): TicketJsonReport {
  return {
    TICKET_ID: result.id,
    TICKET_DIR: `${displayPath(ctx.cwd, result.dir)}/`,
    state: result.state,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    entries: result.entries.map((entry) => ({
      ...entry,
      modifiedAt: entry.modifiedAt.toISOString(),
    })),
  };
}

function renderReport(
  ctx: CommandContext,
  options: TicketOptions,
  result: ResolvedTicketDir,
): string {
  const reservation = options.side && options.dryRun ? " (would be reserved)" : "";
  const deduction =
    options.branch === undefined ? "" : ` (deduced from branch \`${options.branch}\`)`;
  const directoryState = renderDirectoryState(result.state, options.dryRun);
  const directory = `${displayPath(ctx.cwd, result.dir)}/`;
  const lines = [
    `- TICKET_ID: \`${result.id}\`${reservation}${deduction}`,
    `- TICKET_DIR: \`${directory}\`${directoryState}`,
  ];
  if (result.entries.length === 0) lines.push("- Entries: (none)");
  else lines.push("- Entries:", ...result.entries.map((entry) => `  - ${renderEntry(entry)}`));
  return `${lines.join("\n")}\n`;
}

function renderEntry(entry: TicketEntry): string {
  const name = `\`${entry.name}\``;
  if (entry.size === undefined) return name;
  return `${name} (${formatSize(entry.size)}, ${formatLocalTimestamp(entry.modifiedAt)})`;
}

function renderDirectoryState(state: ResolvedTicketDir["state"], dryRun: boolean): string {
  if (state === "existing") return "";
  if (state === "created") return dryRun ? " (would be created)" : " (created)";
  return dryRun ? " (would be restored from _archives)" : " (restored from _archives)";
}
