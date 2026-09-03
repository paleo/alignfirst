import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import { renderCommandForm } from "../command-form.js";
import type { CommandContext } from "../context.js";
import { resolveProjectFile } from "../overlay.js";
import { parseCommandArgs } from "../parse-args.js";
import { PROTOCOLS, type Protocol } from "../protocols.js";

const TICKET_ID_RULE_PLACEHOLDER = "{{TICKET_ID_RULE}}";
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
  if (options.protocolOnly && options.protocol !== undefined)
    return readProtocolTemplate(options.protocol);
  const core = renderCoreGuide(ctx);
  if (options.protocol === undefined) return core;
  return `${core.trimEnd()}\n\n${readProtocolTemplate(options.protocol).trimEnd()}`;
}

function renderReviewerGuide(perspective: Perspective, modules: ReviewModule[]): string {
  const templates = [
    readGuideTemplate("code-review/reviewer-common.md"),
    readGuideTemplate(`code-review/${perspective}-reviewer.md`),
    ...modules.map((module) => readGuideTemplate(`code-review/module-${module}.md`)),
  ];
  return templates.map((template) => template.trimEnd()).join("\n\n");
}

function renderCoreGuide(ctx: CommandContext): string {
  const ticketRule = renderTicketIdRule(ctx);
  const core = readGuideTemplate("core.md").replaceAll(
    TICKET_ID_RULE_PLACEHOLDER,
    () => ticketRule,
  );
  const projectConventions = resolveProjectFile(ctx.cwd, ctx.overlay, "AGENTS.md");
  if (projectConventions?.source !== "overlay") return core;
  const content = readFileSync(projectConventions.path, "utf-8").trimEnd();
  return `${core.trimEnd()}\n\n## Project conventions\n\n${content}`;
}

function renderTicketIdRule(ctx: CommandContext): string {
  const pattern = ctx.projectConfig?.config.ticketPattern;
  if (pattern === undefined) return "Ask the user for the ticket ID when it is not given.";
  return `Ticket IDs match \`${pattern}\`. When the user gives no id, run \`{{CMD}} ticket\` without an id: it deduces the id from the current branch.`;
}

function readProtocolTemplate(protocol: Protocol): string {
  return readGuideTemplate(`protocols/${protocol}.md`);
}

function readGuideTemplate(path: string): string {
  return readFileSync(new URL(`../../templates/guide/${path}`, import.meta.url), "utf-8").trimEnd();
}
