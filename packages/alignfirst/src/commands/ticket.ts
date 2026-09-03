import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import { assertPlansGate } from "../plans/layout.js";
import {
  deduceTicketFromBranch,
  nextFileName,
  peekSideTicket,
  reserveSideTicket,
  resolveTicketDir,
  type ResolvedTicketDir,
  validateTicketId,
} from "../plans/ticket.js";

const USAGE = `Usage:
  {{FORM}} ticket [<id>] [--next <filename>] [--new-cycle] [--json] [--dry-run]
  {{FORM}} ticket --side [--json] [--dry-run]
`;

interface TicketOptions {
  id: string;
  branch?: string;
  next?: string;
  newCycle: boolean;
  json: boolean;
  dryRun: boolean;
  side: boolean;
}

interface TicketJsonReport {
  id: string;
  dir: string;
  state: ResolvedTicketDir["state"];
  branch?: string;
  entries: string[];
  next?: string;
}

export function runTicket(ctx: CommandContext, args: string[]): number {
  assertPlansGate(ctx.cwd, ctx.form);
  const usage = renderUsage(ctx);
  const parsed = parseTicketArgs(ctx, args, usage);
  if (parsed === undefined) return 0;
  const result = resolveTicket(ctx, parsed);
  const next =
    parsed.next === undefined ? undefined : nextFileName(result.dir, parsed.next, parsed.newCycle);
  if (parsed.json)
    ctx.stdout.write(`${JSON.stringify(jsonReport(ctx, parsed, result, next), undefined, 2)}\n`);
  else ctx.stdout.write(renderReport(ctx, parsed, result, next));
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
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        next: { type: "string" },
        "new-cycle": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        side: { type: "boolean", default: false },
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
  const resolution = resolveTicketId(ctx, positionals[0], values.side, values["dry-run"]);
  return {
    ...resolution,
    next: values.next,
    newCycle: values["new-cycle"],
    json: values.json,
    dryRun: values["dry-run"],
    side: values.side,
  };
}

interface TicketResolution {
  id: string;
  branch?: string;
}

function resolveTicketId(
  ctx: CommandContext,
  positional: string | undefined,
  side: boolean,
  dryRun: boolean,
): TicketResolution {
  const pattern = ctx.projectConfig?.config.ticketPattern;
  if (positional !== undefined) {
    validateTicketId(positional, pattern);
    return { id: positional };
  }
  if (side) return { id: dryRun ? peekSideTicket(ctx.cwd) : reserveSideTicket(ctx.cwd) };
  if (pattern === undefined)
    throw new CliError(
      "No ticket id given and .alignfirst.json has no ticketPattern: pass the id.",
    );
  const deduced = deduceTicketFromBranch(ctx.cwd, pattern);
  validateTicketId(deduced.id, pattern);
  return deduced;
}

function resolveTicket(ctx: CommandContext, options: TicketOptions): ResolvedTicketDir {
  if (options.side && !options.dryRun)
    return {
      id: options.id,
      dir: join(ctx.cwd, ".plans", options.id),
      state: "created",
      entries: [],
    };
  return resolveTicketDir(ctx.cwd, options.id, { dryRun: options.dryRun });
}

function jsonReport(
  ctx: CommandContext,
  options: TicketOptions,
  result: ResolvedTicketDir,
  next: string | undefined,
): TicketJsonReport {
  return {
    id: result.id,
    dir: relative(ctx.cwd, result.dir),
    state: result.state,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    entries: result.entries,
    ...(next === undefined ? {} : { next: relative(ctx.cwd, join(result.dir, next)) }),
  };
}

function renderReport(
  ctx: CommandContext,
  options: TicketOptions,
  result: ResolvedTicketDir,
  next: string | undefined,
): string {
  const reservation = options.side && options.dryRun ? " (would be reserved)" : "";
  const deduction = options.branch === undefined ? "" : ` (deduced from branch ${options.branch})`;
  const directoryState = renderDirectoryState(result.state, options.dryRun);
  const directory = `${relative(ctx.cwd, result.dir)}/`;
  const lines = [
    `Ticket ${result.id}${reservation}${deduction}`,
    `Directory: ${directory}${directoryState}`,
  ];
  if (result.entries.length === 0) lines.push("Entries: (none)");
  else lines.push("Entries:", ...result.entries.map((entry) => `  ${entry}`));
  if (next !== undefined) lines.push(`Next file: ${relative(ctx.cwd, join(result.dir, next))}`);
  return `${lines.join("\n")}\n`;
}

function renderDirectoryState(state: ResolvedTicketDir["state"], dryRun: boolean): string {
  if (state === "existing") return "";
  if (state === "created") return dryRun ? " (would be created)" : " (created)";
  return dryRun ? " (would be restored from _archives)" : " (restored from _archives)";
}
