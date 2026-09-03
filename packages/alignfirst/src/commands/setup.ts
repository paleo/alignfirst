import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { assertMainWorktreeRoot, gitOutputOrUndefined, gitSucceeds } from "../git.js";
import { normalizeRemoteUrl } from "../overlay.js";
import { parseCommandArgs } from "../parse-args.js";
import { linkPlans } from "../plans/link.js";
import {
  PROJECT_CONFIG_FILENAME,
  type PortRange,
  type ProjectConfig,
  readProjectConfig,
  validateProjectConfig,
} from "../project-config.js";
import { installStubSkills } from "../skills.js";
import { defaultCliRange } from "../version-guard.js";

const ADOPT_FILES = ["AGENTS.md", "DEVELOPERS.md", "docs"] as const;

interface SetupOptions {
  ticketPattern?: string;
  plansFolder?: string;
  portRange?: PortRange;
  agents: string[];
  overlay: boolean;
  adopt: boolean;
}

export function runSetup(ctx: CommandContext, args: string[]): number {
  const usage = setupUsage(ctx);
  const options = parseSetupArgs(ctx, args, usage);
  if (options === undefined) return 0;
  if (options.overlay) return runOverlaySetup(ctx, options);
  if (options.adopt) return runAdopt(ctx);
  return runDefaultSetup(ctx, options);
}

function setupUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} setup [--ticket-pattern <regex>] [--plans-folder <name>] [--port-range <first>-<last>] [--agent <name>]...
  ${ctx.form} setup --overlay [--plans-folder <name>] [--ticket-pattern <regex>] [--port-range <first>-<last>]
  ${ctx.form} setup --adopt
`;
}

function parseSetupArgs(
  ctx: CommandContext,
  args: string[],
  usage: string,
): SetupOptions | undefined {
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        "ticket-pattern": { type: "string" },
        "plans-folder": { type: "string" },
        "port-range": { type: "string" },
        agent: { type: "string", multiple: true, default: [] },
        overlay: { type: "boolean", default: false },
        adopt: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (values.overlay && values.adopt)
    throw new CliError(`--overlay and --adopt are mutually exclusive.\n\n${usage}`);
  if ((values.overlay || values.adopt) && values.agent.length > 0)
    throw new CliError(`--agent is available only in the default setup mode.\n\n${usage}`);
  const portRange =
    values["port-range"] === undefined ? undefined : parsePortRange(values["port-range"], usage);
  const options: SetupOptions = {
    ticketPattern: values["ticket-pattern"],
    plansFolder: values["plans-folder"],
    portRange,
    agents: values.agent,
    overlay: values.overlay,
    adopt: values.adopt,
  };
  validateSetupOptions(options);
  return options;
}

function parsePortRange(value: string, usage: string): PortRange {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw new CliError(`--port-range must be <first>-<last>.\n\n${usage}`);
  return { first: Number(match[1]), last: Number(match[2]) };
}

function validateSetupOptions(options: SetupOptions): void {
  validateProjectConfig(
    {
      schemaVersion: 1,
      ...(options.ticketPattern === undefined ? {} : { ticketPattern: options.ticketPattern }),
      ...(options.plansFolder === undefined ? {} : { plans: { folder: options.plansFolder } }),
      ...(options.portRange === undefined ? {} : { portRange: options.portRange }),
    },
    PROJECT_CONFIG_FILENAME,
  );
}

function runDefaultSetup(ctx: CommandContext, options: SetupOptions): number {
  assertMainWorktreeRoot(ctx.cwd);
  setupProjectConfig(ctx, options);
  setupPlansDirectory(ctx);
  installStubSkills(ctx, options.agents);
  ctx.stdout.write("Installed the AlignFirst skills globally.\n");
  setupReadme(ctx);
  return 0;
}

function setupProjectConfig(ctx: CommandContext, options: SetupOptions): void {
  const path = join(ctx.cwd, PROJECT_CONFIG_FILENAME);
  if (existsSync(path)) {
    readProjectConfig(ctx.cwd);
    ctx.stdout.write(`${PROJECT_CONFIG_FILENAME} is valid.\n`);
    if (hasProjectOptions(options))
      throw new CliError(`${PROJECT_CONFIG_FILENAME} exists; edit it instead of passing options.`);
    return;
  }
  const cli = defaultCliRange(ctx.version);
  const config = validateProjectConfig(
    {
      schemaVersion: 1,
      cli,
      ...(options.ticketPattern === undefined ? {} : { ticketPattern: options.ticketPattern }),
      ...(options.plansFolder === undefined ? {} : { plans: { folder: options.plansFolder } }),
      ...(options.portRange === undefined ? {} : { portRange: options.portRange }),
    },
    PROJECT_CONFIG_FILENAME,
  );
  writeJson(path, config);
  ctx.stdout.write(`Created ${PROJECT_CONFIG_FILENAME} (cli ${cli})\n`);
}

function hasProjectOptions(options: SetupOptions): boolean {
  return (
    options.ticketPattern !== undefined ||
    options.plansFolder !== undefined ||
    options.portRange !== undefined
  );
}

function setupPlansDirectory(ctx: CommandContext): void {
  const plansPath = join(ctx.cwd, ".plans");
  if (!existsSync(plansPath)) {
    mkdirSync(plansPath);
    ctx.stdout.write("Created .plans/\n");
  }
  if (gitSucceeds(ctx.cwd, "check-ignore", "-q", ".plans")) return;
  appendLine(join(ctx.cwd, ".gitignore"), ".plans");
  ctx.stdout.write("Added .plans to .gitignore.\n");
}

function appendLine(path: string, line: string): void {
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}${line}\n`);
}

function setupReadme(ctx: CommandContext): void {
  const path = join(ctx.cwd, "README.md");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  if (/alignfirst/i.test(content)) return;
  appendFileSync(
    path,
    "\n## Prerequisites\n\nInstall the AlignFirst CLI: `npm install -g alignfirst`.\n",
  );
  ctx.stdout.write("Added the CLI prerequisite to README.md.\n");
}

function runOverlaySetup(ctx: CommandContext, options: SetupOptions): number {
  const overlaysDir = resolveOverlaysDir(ctx);
  assertMainWorktreeRoot(ctx.cwd);
  const projectPath = realpathSync(ctx.cwd);
  const name = options.plansFolder ?? basename(projectPath);
  const overlayDir = join(overlaysDir, name, "_project");
  if (existsSync(overlayDir)) throw new CliError(`${overlayDir} already exists.`);
  const config = buildOverlayConfig(ctx, options, projectPath);
  mkdirSync(overlayDir, { recursive: true });
  writeJson(join(overlayDir, PROJECT_CONFIG_FILENAME), config);
  ctx.stdout.write(`Created overlay: ${overlayDir}\n`);
  setupOverlayPlans(ctx, overlaysDir, name);
  setupGitExclude(ctx);
  return 0;
}

function resolveOverlaysDir(ctx: CommandContext): string {
  const value = ctx.env.ALIGNFIRST_OVERLAYS;
  if (value === undefined || value === "") throw new CliError("ALIGNFIRST_OVERLAYS is not set.");
  return value.startsWith("~/") ? join(ctx.home, value.slice(2)) : value;
}

function buildOverlayConfig(
  ctx: CommandContext,
  options: SetupOptions,
  projectPath: string,
): ProjectConfig {
  const origin = gitOutputOrUndefined(ctx.cwd, "remote", "get-url", "origin");
  return validateProjectConfig(
    {
      schemaVersion: 1,
      project: {
        ...(origin === undefined || origin === "" ? {} : { remote: normalizeRemoteUrl(origin) }),
        paths: [projectPath],
      },
      ...(options.ticketPattern === undefined ? {} : { ticketPattern: options.ticketPattern }),
      ...(options.plansFolder === undefined ? {} : { plans: { folder: options.plansFolder } }),
      ...(options.portRange === undefined ? {} : { portRange: options.portRange }),
    },
    PROJECT_CONFIG_FILENAME,
  );
}

function setupOverlayPlans(ctx: CommandContext, overlaysDir: string, name: string): void {
  if (gitSucceeds(overlaysDir, "rev-parse", "--git-dir")) {
    linkPlans(ctx, join(overlaysDir, name));
    return;
  }
  const plansPath = join(ctx.cwd, ".plans");
  if (!existsSync(plansPath)) mkdirSync(plansPath);
  ctx.stdout.write("Using a local .plans directory.\n");
}

function setupGitExclude(ctx: CommandContext): void {
  if (gitSucceeds(ctx.cwd, "check-ignore", "-q", ".plans")) return;
  appendLine(join(ctx.cwd, ".git", "info", "exclude"), ".plans");
  ctx.stdout.write("Added .plans to .git/info/exclude.\n");
}

function runAdopt(ctx: CommandContext): number {
  const overlay = ctx.overlay;
  if (overlay === undefined) {
    const value = ctx.env.ALIGNFIRST_OVERLAYS;
    throw new CliError(
      `No overlay matches this repository (ALIGNFIRST_OVERLAYS=${value === undefined || value === "" ? "unset" : value}).`,
    );
  }
  adoptConfig(ctx, overlay.dir, overlay.config);
  const agentsConflict = adoptFiles(ctx, overlay.dir);
  removePlansExclude(ctx);
  if (readdirSync(overlay.dir).length === 0) rmdirSync(overlay.dir);
  else ctx.stdout.write(`Overlay remains: ${overlay.dir}\n`);
  ctx.stdout.write("Next: add .plans to .gitignore.\n");
  if (agentsConflict) ctx.stdout.write("Next: merge the overlay AGENTS.md conventions by hand.\n");
  return 0;
}

function adoptConfig(ctx: CommandContext, overlayDir: string, config: ProjectConfig): void {
  const name = PROJECT_CONFIG_FILENAME;
  const source = join(overlayDir, name);
  const target = join(ctx.cwd, name);
  if (existsSync(target)) {
    ctx.stdout.write(`kept in the overlay: ${name} (the root has its own)\n`);
    return;
  }
  const rootConfig = structuredClone(config);
  delete rootConfig.project;
  writeJson(target, validateProjectConfig(rootConfig, name));
  unlinkSync(source);
  ctx.stdout.write(`Adopted ${name}.\n`);
}

function adoptFiles(ctx: CommandContext, overlayDir: string): boolean {
  let agentsConflict = false;
  for (const name of ADOPT_FILES) {
    const source = join(overlayDir, name);
    if (!existsSync(source)) continue;
    const target = join(ctx.cwd, name);
    if (existsSync(target)) {
      ctx.stdout.write(`kept in the overlay: ${name} (the root has its own)\n`);
      if (name === "AGENTS.md") agentsConflict = true;
      continue;
    }
    renameSync(source, target);
    ctx.stdout.write(`Adopted ${name}.\n`);
  }
  return agentsConflict;
}

function removePlansExclude(ctx: CommandContext): void {
  const path = join(ctx.cwd, ".git", "info", "exclude");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => line.trim() !== ".plans");
  if (filtered.length === lines.length) return;
  writeFileSync(path, filtered.join("\n"));
  ctx.stdout.write("Removed .plans from .git/info/exclude.\n");
}

function writeJson(path: string, value: ProjectConfig): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
