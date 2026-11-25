import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import { runSetupInit } from "../setup/init.js";
import {
  fenced,
  formatLocation,
  type InstructionReport,
  inspectInstructions,
  renderBootstrapSection,
  renderGlobalBootstrapSection,
  instructionFilePath,
  writeBootstrapSection,
} from "../setup/instruction-status.js";
import type { BootstrapLocation } from "../setup/instructions.js";
import { writeStateReport } from "../setup/report.js";
import { renderSetupTemplate, renderTopic, renderTopicList } from "../setup/topics.js";
import { parseItemOptions } from "./companion.js";

const HELP_OPTION = { help: { type: "boolean", short: "h", default: false } } as const;

export function runSetup(ctx: CommandContext, args: string[]): number | Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      return runReport(ctx);
    case "guide":
      return runGuide(ctx, rest);
    case "init":
      return runInit(ctx, rest);
    case "instructions":
      return runInstructions(ctx, rest);
    case "--help":
    case "-h":
      ctx.stdout.write(setupUsage(ctx));
      return 0;
    default:
      throw new CliError(`Unknown setup command "${command}".\n\n${setupUsage(ctx)}`);
  }
}

function setupUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} setup
  ${ctx.form} setup guide [<topic>]
  ${ctx.form} setup init [options]
  ${ctx.form} setup instructions [--write] [--file <path>]
`;
}

function runReport(ctx: CommandContext): number {
  writeStateReport(ctx);
  ctx.stdout.write(`\n${renderSetupTemplate(ctx, "entry.md")}\n`);
  return 0;
}

function runGuide(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} setup guide [<topic>]\n`;
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({ args, options: HELP_OPTION, strict: true, allowPositionals: true } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return 0;
  }
  if (positionals.length > 1) throw new CliError(`Expected at most one topic.\n\n${usage}`);
  const [topic] = positionals;
  ctx.stdout.write(`${topic === undefined ? renderTopicList() : renderTopic(ctx, topic)}\n`);
  return 0;
}

async function runInit(ctx: CommandContext, args: string[]): Promise<number> {
  const usage = initUsage(ctx);
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        "ticket-pattern": { type: "string" },
        "default-branch": { type: "string" },
        "branch-template": { type: "string" },
        "commit-style": { type: "string" },
        "commit-ticket-reference": { type: "string" },
        "no-agent-coauthoring": { type: "boolean" },
        "plans-folder": { type: "string" },
        "default-location": { type: "string" },
        item: { type: "string", multiple: true },
        "git-exclude": { type: "boolean", default: false },
        "no-instructions": { type: "boolean", default: false },
        ...HELP_OPTION,
      },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return 0;
  }
  if (positionals.length > 0)
    throw new CliError(`Unexpected argument: ${positionals[0]}\n\n${usage}`);
  await runSetupInit(ctx, {
    conventions: {
      "ticket-pattern": values["ticket-pattern"],
      "default-branch": values["default-branch"],
      "branch-template": values["branch-template"],
      "commit-style": values["commit-style"],
      "commit-ticket-reference": values["commit-ticket-reference"],
      "no-agent-coauthoring": values["no-agent-coauthoring"],
      "plans-folder": values["plans-folder"],
    },
    defaultLocation: values["default-location"],
    items: parseItemOptions(values.item ?? [], usage),
    gitExclude: values["git-exclude"],
    instructions: !values["no-instructions"],
  });
  return 0;
}

function initUsage(ctx: CommandContext): string {
  return `Usage: ${ctx.form} setup init [options]

Adopts the AlignFirst protocols in the project. Runs from the main-worktree root. Idempotent:
validates everything before the first change, then prints one line per step.

Configuration (written only when no alignfirst.json or alignfirst.jsonc exists):
  --ticket-pattern <regex>          conventions.ticketIdPattern
  --default-branch <name>           conventions.git.defaultBranch
  --branch-template <template>      conventions.git.branchNameTemplate
  --commit-style conventionalCommit conventions.git.commit.style
  --commit-ticket-reference <bracketed|bracketedHash>
                                    conventions.git.commit.ticketReference
  --no-agent-coauthoring            conventions.git.agentCoauthoring: false
  --plans-folder <name>             plans.repositoryFolder

Companion:
  --default-location <project|companion|auto>
                                    Register a companion with this defaultLocation.
  --item <name>=<location>          Set one companion item. Repeatable.

Other options:
  --git-exclude                     Write ignore rules to .git/info/exclude, not .gitignore.
  --no-instructions                 Leave AGENTS.md and CLAUDE.md untouched.
`;
}

function runInstructions(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} setup instructions [--write] [--file <path>]

Diagnoses the bootstrap section of AGENTS.md and CLAUDE.md. With --write, inserts it when it is
absent, and changes nothing otherwise. --file selects AGENTS.md or CLAUDE.md at the root.
`;
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        write: { type: "boolean", default: false },
        file: { type: "string" },
        ...HELP_OPTION,
      },
      strict: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return 0;
  }
  if (values.file !== undefined && !values.write)
    throw new CliError(`--file requires --write.\n\n${usage}`);
  const report = inspectInstructions(ctx);
  const target =
    values.file === undefined ? undefined : instructionFilePath(ctx, report.root, values.file);
  if (values.write && report.status === "absent") {
    const path = writeBootstrapSection(ctx, report.root, target);
    ctx.stdout.write(`Status: absent\nInserted the bootstrap section in ${path}.\n`);
    return 0;
  }
  ctx.stdout.write(renderInstructionReport(ctx, report));
  return 0;
}

function renderInstructionReport(ctx: CommandContext, report: InstructionReport): string {
  const { diagnosis } = report;
  const lines = [`Status: ${report.status}`];
  if (diagnosis.status === "current" || diagnosis.status === "differs")
    lines.push(`Location: ${formatLocation(ctx, diagnosis.locations[0])}`);
  for (const section of diagnosis.legacySections)
    lines.push(`Legacy section: ${formatLocation(ctx, section)} (${section.heading.trim()})`);
  return `${lines.join("\n")}\n\n${renderStatusGuidance(ctx, report)}`;
}

/** Ends with the section the project should carry. */
function renderStatusGuidance(ctx: CommandContext, report: InstructionReport): string {
  if (report.status === "global")
    return `The companion's defaultLocation is "companion": the repository carries no section. Add this section to the global agent instructions instead (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.pi/agent/AGENTS.md, ~/.gemini/AGENTS.md or the agent's equivalent):\n\n${fenced(renderGlobalBootstrapSection(ctx, report.root))}`;
  const canonical = `Canonical section:\n\n${fenced(renderBootstrapSection(ctx))}`;
  const { diagnosis } = report;
  switch (diagnosis.status) {
    case "absent":
      return `Insert it with \`${ctx.form} setup instructions --write\`.\n\n${canonical}`;
    case "differs":
      return `Current text:\n\n${fenced(diagnosis.current)}\nEdit the section to match the canonical text, keeping project-specific additions.\n\n${canonical}`;
    case "ambiguous":
      return `Several sections mention \`alignfirst context\`, or a mention sits outside a level-2 section:\n${renderMentions(ctx, diagnosis.locations)}\n\nKeep a single level-2 section that holds the command, matching the canonical text.\n\n${canonical}`;
    case "current":
      return canonical;
  }
}

function renderMentions(ctx: CommandContext, locations: BootstrapLocation[]): string {
  return locations
    .map(
      (location) =>
        `- ${formatLocation(ctx, location)} (${location.heading?.trim() ?? "outside any level-2 section"})`,
    )
    .join("\n");
}
