import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import { renderCommandForm } from "../command-form.js";
import { commitSubject, renderConventions } from "../conventions.js";
import type { CommandContext } from "../context.js";
import { resolveDefaultBranch } from "../default-branch.js";
import { parseCommandArgs } from "../parse-args.js";
import { missingPlansMessage } from "../plans/layout.js";
import { resolvePlansMode } from "../plans/mode.js";
import { detectTicketFromBranch, type TicketDetection } from "../plans/ticket.js";
import { PROTOCOLS, type Protocol } from "../protocols.js";

const TICKET_CMD_PLACEHOLDER = "{{TICKET_CMD}}";
const TICKET_CONTEXT_PLACEHOLDER = "{{TICKET_CONTEXT}}";
const PLANS_STATE_PLACEHOLDER = "{{PLANS_STATE}}";
const COMMIT_RULE_PLACEHOLDER = "{{COMMIT_RULE}}";
const BASE_BRANCH_RULE_PLACEHOLDER = "{{BASE_BRANCH_RULE}}";
const PERSPECTIVES = ["intent", "correctness", "safety", "quality"] as const;
const MODULES = ["typescript-strict", "javascript", "python"] as const;
const PROTOCOL_LIST = `${PROTOCOLS.join(", ")}, or overview`;
const PERSPECTIVE_LIST = PERSPECTIVES.join(", ");
const MODULE_LIST = MODULES.join(", ");

interface GuideOptions {
  protocol?: Protocol | "overview";
  protocolOnly: boolean;
  reviewer?: Perspective;
  modules: ReviewModule[];
}

type Perspective = (typeof PERSPECTIVES)[number];
type ReviewModule = (typeof MODULES)[number];

interface GuidePlaceholders {
  ticketCommand: string;
  ticketContext: string;
  plansState: string;
  commitRule: string;
  baseBranchRule: string;
}

export function runGuide(ctx: CommandContext, args: string[]): number {
  const usage = renderUsage(ctx);
  const options = parseGuideArgs(ctx, args, usage);
  if (options === undefined) return 0;
  const guide = renderGuide(ctx, options);
  ctx.stdout.write(`${renderCommandForm(guide, ctx.form).trimEnd()}\n`);
  return 0;
}

function renderUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} guide [<protocol>] [--protocol-only]
  ${ctx.form} guide overview
  ${ctx.form} guide review --reviewer <perspective> [--module <module>]...
`;
}

function parseGuideArgs(
  ctx: CommandContext,
  args: string[],
  usage: string,
): GuideOptions | undefined {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        "protocol-only": { type: "boolean", default: false },
        reviewer: { type: "string" },
        module: { type: "string", multiple: true },
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
  if (positionals.length > 1) throw new CliError(`Expected at most one protocol.\n\n${usage}`);
  const protocol = parseProtocol(positionals[0]);
  const reviewer = parsePerspective(values.reviewer);
  const modules = (values.module ?? []).map(parseModule);
  validateOptions(protocol, values["protocol-only"], reviewer, modules);
  return { protocol, protocolOnly: values["protocol-only"], reviewer, modules };
}

function parseProtocol(value: string | undefined): Protocol | "overview" | undefined {
  if (value === undefined || value === "overview") return value;
  const protocol = PROTOCOLS.find((candidate) => candidate === value);
  if (protocol === undefined)
    throw new CliError(`Unknown protocol "${value}". Protocols: ${PROTOCOL_LIST}.`);
  return protocol;
}

function parsePerspective(value: string | undefined): Perspective | undefined {
  if (value === undefined) return;
  const perspective = PERSPECTIVES.find((candidate) => candidate === value);
  if (perspective === undefined)
    throw new CliError(`Unknown reviewer "${value}". Reviewers: ${PERSPECTIVE_LIST}.`);
  return perspective;
}

function parseModule(value: string): ReviewModule {
  const module = MODULES.find((candidate) => candidate === value);
  if (module === undefined)
    throw new CliError(`Unknown module "${value}". Modules: ${MODULE_LIST}.`);
  return module;
}

function validateOptions(
  protocol: GuideOptions["protocol"],
  protocolOnly: boolean,
  reviewer: Perspective | undefined,
  modules: ReviewModule[],
): void {
  if (protocolOnly && protocol === undefined)
    throw new CliError("--protocol-only requires a protocol.");
  if (protocolOnly && protocol === "overview")
    throw new CliError("--protocol-only cannot be used with overview.");
  if (reviewer !== undefined && protocol !== "review")
    throw new CliError("--reviewer can only be used with review.");
  if (modules.length > 0 && reviewer === undefined)
    throw new CliError("--module requires --reviewer.");
}

function renderGuide(ctx: CommandContext, options: GuideOptions): string {
  if (options.reviewer !== undefined) return renderReviewerGuide(options.reviewer, options.modules);
  if (options.protocol === "overview") return readGuideTemplate("overview.md");
  const placeholders = buildGuidePlaceholders(ctx, options.protocol);
  if (options.protocolOnly && options.protocol !== undefined)
    return applyPlaceholders(readProtocolTemplate(options.protocol), placeholders);
  const core = renderCoreGuide(ctx, placeholders);
  if (options.protocol === undefined) return core;
  const protocol = applyPlaceholders(readProtocolTemplate(options.protocol), placeholders);
  return `${core.trimEnd()}\n\n${protocol.trimEnd()}`;
}

function renderReviewerGuide(perspective: Perspective, modules: ReviewModule[]): string {
  const templates = [
    readGuideTemplate("code-review/reviewer-common.md"),
    readGuideTemplate(`code-review/${perspective}-reviewer.md`),
    ...modules.map((module) => readGuideTemplate(`code-review/module-${module}.md`)),
  ];
  return templates.map((template) => template.trimEnd()).join("\n\n");
}

function renderCoreGuide(ctx: CommandContext, placeholders: GuidePlaceholders): string {
  const core = applyPlaceholders(readGuideTemplate("core.md"), placeholders);
  if (ctx.projectConfig !== undefined) return core;
  return `${core.trimEnd()}\n\n## Project conventions\n\n${renderConventions(ctx).trimEnd()}`;
}

function buildGuidePlaceholders(
  ctx: CommandContext,
  protocol: GuideOptions["protocol"],
): GuidePlaceholders {
  const pattern = ctx.projectConfig?.config.ticketIdPattern;
  const detection = pattern === undefined ? undefined : detectTicketFromBranch(ctx.cwd, pattern);
  return {
    ticketCommand: detection?.kind === "detected" ? "{{CMD}} ticket" : "{{CMD}} ticket <id>",
    ticketContext: renderTicketContext(pattern, detection),
    plansState: renderPlansState(ctx),
    commitRule: renderCommitRule(ctx),
    baseBranchRule: renderBaseBranchRule(ctx, protocol),
  };
}

function renderTicketContext(
  pattern: string | undefined,
  detection: TicketDetection | undefined,
): string {
  if (pattern === undefined) return "Ask the user for the ticket ID when it is not given.";
  if (detection?.kind === "detected")
    return `Current ticket: \`${detection.id}\` (from branch \`${detection.branch}\`). The id argument of \`{{CMD}} ticket\` is optional and defaults to it; pass an id only when the user names another ticket.`;
  if (detection?.kind === "noMatch")
    return `No ticket id on branch \`${detection.branch}\`. Ask the user for the id.`;
  return "No ticket id: detached HEAD. Ask the user for the id.";
}

function renderPlansState(ctx: CommandContext): string {
  const entry = lstatSync(join(ctx.cwd, ".plans"), { throwIfNoEntry: false });
  if (entry === undefined) return `\`\`\`text\n${missingPlansMessage(ctx.form)}\n\`\`\``;
  try {
    return resolvePlansMode(ctx.cwd, ctx.form).kind === "shared"
      ? "After every change in TASK_DIR, run `{{CMD}} sync`."
      : "";
  } catch {
    return "";
  }
}

function renderCommitRule(ctx: CommandContext): string {
  const commit = ctx.projectConfig?.config.git?.commit;
  if (commit === undefined)
    return "(follow the convention you are aware of, or default to `<type>: [<ticket_id>] very short description`)";
  const { subject, side } = commitSubject(commit);
  const rule = side === undefined ? subject : `${subject}; ${side}`;
  return `(project convention: ${rule})`;
}

function renderBaseBranchRule(ctx: CommandContext, protocol: GuideOptions["protocol"]): string {
  const branch = resolveDefaultBranch(ctx.cwd, ctx.projectConfig?.config);
  if (protocol === "review")
    return branch === undefined
      ? "the **base branch** to compare against - use the branch provided by the user, or fall back to the default branch."
      : `the **base branch** to compare against - use the branch provided by the user, or fall back to \`${branch.name}\`, the default branch.`;
  if (protocol === "merge")
    return branch === undefined
      ? "otherwise ask which branch to merge."
      : `otherwise merge \`${branch.name}\`, the default branch.`;
  return "";
}

function applyPlaceholders(template: string, values: GuidePlaceholders): string {
  return template
    .replaceAll(`${PLANS_STATE_PLACEHOLDER}\n\n`, () =>
      values.plansState === "" ? "" : `${values.plansState}\n\n`,
    )
    .replaceAll(TICKET_CMD_PLACEHOLDER, () => values.ticketCommand)
    .replaceAll(TICKET_CONTEXT_PLACEHOLDER, () => values.ticketContext)
    .replaceAll(PLANS_STATE_PLACEHOLDER, () => values.plansState)
    .replaceAll(COMMIT_RULE_PLACEHOLDER, () => values.commitRule)
    .replaceAll(BASE_BRANCH_RULE_PLACEHOLDER, () => values.baseBranchRule);
}

function readProtocolTemplate(protocol: Protocol): string {
  return readGuideTemplate(`protocols/${protocol}.md`);
}

function readGuideTemplate(path: string): string {
  return readFileSync(new URL(`../../templates/guide/${path}`, import.meta.url), "utf-8").trimEnd();
}
