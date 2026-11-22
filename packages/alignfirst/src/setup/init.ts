import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { errorMessage } from "../errors.js";
import { assertMainWorktreeRoot, gitOutput, gitSucceeds } from "../git.js";
import { assertPlansNotProjectTracked } from "../plans/layout.js";
import { validateProjectConfig } from "../project-config.js";
import {
  type ItemName,
  layoutOf,
  type ProjectLayout,
  registerCompanion,
} from "../project-layout.js";
import {
  describeInstructions,
  fenced,
  inspectInstructions,
  renderGlobalBootstrapSection,
  writeBootstrapSection,
} from "./instruction-status.js";

export interface SetupInitOptions {
  conventions: ConventionOptions;
  defaultLocation?: string;
  items: Partial<Record<ItemName, string>>;
  gitExclude: boolean;
  instructions: boolean;
}

/** The configuration flags, each named after its command-line option. */
export interface ConventionOptions {
  "ticket-pattern"?: string;
  "default-branch"?: string;
  "branch-template"?: string;
  "commit-style"?: string;
  "commit-ticket-reference"?: string;
  "no-agent-coauthoring"?: boolean;
  "plans-folder"?: string;
}

type StepStatus = "created" | "updated" | "unchanged" | "skipped";

/** Validates everything before the first change, then applies each step idempotently. */
export async function runSetupInit(ctx: CommandContext, options: SetupInitOptions): Promise<void> {
  const config = validateInit(ctx, options);
  await applyCompanion(ctx, options);
  const layout = layoutOf(ctx);
  assertPlansNotProjectTracked(ctx.cwd, layout.locations[".plans"], ctx.form);
  writeConfiguration(ctx, layout, config, options.conventions);
  createPlansDirectory(ctx, layout);
  addIgnoreRules(ctx, layout, options.gitExclude);
  applyInstructions(ctx, options.instructions);
  ctx.stdout.write(`Check: ${ctx.form} doctor\n`);
}

function validateInit(ctx: CommandContext, options: SetupInitOptions): Record<string, unknown> {
  assertMainWorktreeRoot(ctx.cwd);
  if (Object.keys(options.items).length > 0 && options.defaultLocation === undefined)
    throw new CliError("--item requires --default-location.");
  const { conventions } = options;
  if (
    conventions["commit-ticket-reference"] !== undefined &&
    conventions["commit-style"] === undefined
  )
    throw new CliError("--commit-ticket-reference requires --commit-style.");
  const config = buildConfig(conventions);
  validateProjectConfig(config, "setup init options");
  layoutOf(ctx);
  return config;
}

/** A flag left out leaves its field out; `conventions` and `conventions.git` are omitted when empty. */
function buildConfig(options: ConventionOptions): Record<string, unknown> {
  const commit =
    options["commit-style"] === undefined
      ? undefined
      : definedFields({
          style: options["commit-style"],
          ticketReference: options["commit-ticket-reference"],
        });
  const git = definedFields({
    defaultBranch: options["default-branch"],
    branchNameTemplate: options["branch-template"],
    commit,
    agentCoauthoring: options["no-agent-coauthoring"] === true ? false : undefined,
  });
  const conventions = definedFields({ ticketIdPattern: options["ticket-pattern"], git });
  return {
    schemaVersion: 1,
    ...(conventions === undefined ? {} : { conventions }),
    plans: definedFields({ repositoryFolder: options["plans-folder"], autoArchive: true }),
  };
}

function definedFields(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

async function applyCompanion(ctx: CommandContext, options: SetupInitOptions): Promise<void> {
  const { defaultLocation, items } = options;
  if (defaultLocation === undefined) {
    writeStep(ctx, "Companion", "skipped");
    return;
  }
  const registration = await registerCompanion(ctx.cwd, ctx.home, {
    createDir: false,
    defaultLocation,
    items,
  }).catch(rethrowAsCliError);
  ctx.layout = undefined;
  const status = registration.added ? "created" : registration.updated ? "updated" : "unchanged";
  writeStep(ctx, "Companion", status, registration.dir);
}

function rethrowAsCliError(error: unknown): never {
  if (error instanceof CliError) throw error;
  throw new CliError(errorMessage(error));
}

function writeConfiguration(
  ctx: CommandContext,
  layout: ProjectLayout,
  config: Record<string, unknown>,
  conventions: ConventionOptions,
): void {
  const { path, exists } = layout.locations.alignfirst;
  if (exists) {
    writeStep(ctx, "Configuration", "unchanged", path);
    const ignored = Object.entries(conventions)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([name]) => name);
    if (ignored.length > 0)
      ctx.stderr.write(
        `Warning: ${path} exists; not applied: ${ignored.map((name) => `--${name}`).join(", ")}.\n`,
      );
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`);
  writeStep(ctx, "Configuration", "created", path);
}

function createPlansDirectory(ctx: CommandContext, layout: ProjectLayout): void {
  const { path } = layout.locations[".plans"];
  const exists = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  if (!exists) mkdirSync(path, { recursive: true });
  writeStep(ctx, "Work files", exists ? "unchanged" : "created", path);
}

/** Adds a rule only for a path that Git does not already ignore. */
function addIgnoreRules(ctx: CommandContext, layout: ProjectLayout, gitExclude: boolean): void {
  const root = ctx.cwd;
  const target = gitExclude ? excludeFile(root) : join(root, ".gitignore");
  const candidates = [
    { name: ".plans", inProject: layout.locations[".plans"].in === "project" },
    { name: ".local-wt/", inProject: layout.storage.in === "project" },
  ];
  const rules: string[] = [];
  for (const { name, inProject } of candidates) {
    const step = `Ignore ${name}`;
    if (!inProject) writeStep(ctx, step, "skipped");
    else if (gitSucceeds(root, "check-ignore", "-q", "--", name)) writeStep(ctx, step, "unchanged");
    else {
      rules.push(gitExclude ? `/${name}` : name);
      writeStep(ctx, step, "created", target);
    }
  }
  if (rules.length > 0) appendLines(target, rules);
}

function excludeFile(root: string): string {
  return resolve(root, gitOutput(root, "rev-parse", "--git-path", "info/exclude"));
}

function appendLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const separator = previous === "" || previous.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}${lines.join("\n")}\n`);
}

function applyInstructions(ctx: CommandContext, enabled: boolean): void {
  if (!enabled) {
    writeStep(ctx, "Instructions", "skipped");
    return;
  }
  const report = inspectInstructions(ctx);
  if (report.status === "global") {
    writeStep(ctx, "Instructions", "skipped");
    ctx.stdout.write(
      `The companion keeps the repository untouched. Add this section to the global agent instructions:\n\n${fenced(renderGlobalBootstrapSection(ctx, report.root))}`,
    );
    return;
  }
  if (report.status !== "absent") {
    writeStep(ctx, "Instructions", "unchanged", describeInstructions(ctx, report));
    return;
  }
  writeStep(ctx, "Instructions", "created", writeBootstrapSection(ctx, report.root, undefined));
}

/** `detail` is the path, or the instruction status when unchanged. */
function writeStep(ctx: CommandContext, step: string, status: StepStatus, detail?: string): void {
  ctx.stdout.write(`${step}: ${status}${detail === undefined ? "" : ` ${detail}`}\n`);
}
