import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { CliError } from "./cli-error.js";
import { resolveCommandForm } from "./command-form.js";
import { runConfig } from "./commands/config.js";
import { runDevelopers } from "./commands/developers.js";
import { runDoctor } from "./commands/doctor.js";
import { runDocmap } from "./commands/docmap.js";
import { runGuide } from "./commands/guide.js";
import { runPlans } from "./commands/plans.js";
import { runSetup } from "./commands/setup.js";
import { runSync } from "./commands/sync.js";
import { runTicket } from "./commands/ticket.js";
import type { CommandContext, Output } from "./context.js";
import { resolveProjectConfig } from "./overlay.js";
import { checkCliRange } from "./version-guard.js";

export interface MainOptions {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  stdout?: Output;
  stderr?: Output;
}

export async function main(options?: MainOptions): Promise<number> {
  const argv = options?.argv ?? process.argv;
  const env = options?.env ?? process.env;
  const ctx: CommandContext = {
    cwd: options?.cwd ?? process.cwd(),
    env,
    home: options?.home ?? env.HOME ?? env.USERPROFILE ?? homedir(),
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    form: resolveCommandForm(env),
    version: readPackageVersion(),
  };
  const [command, ...args] = argv.slice(2);
  try {
    if (command === "--version" || command === "-v") {
      ctx.stdout.write(`${ctx.version}\n`);
      return 0;
    }
    if (command === undefined || command === "--help" || command === "-h") {
      ctx.stdout.write(renderHelp(ctx));
      return 0;
    }
    if (command !== "config" && command !== "doctor") {
      ctx.projectConfig = resolveProjectConfig(ctx.cwd, ctx.env, ctx.home);
      ctx.overlay = ctx.projectConfig?.overlay;
      checkCliRange(ctx.projectConfig?.config, ctx.version, [command, ...args]);
    }
    return dispatch(ctx, command, args);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.stderr.write(`${error.message}\n`);
    return 1;
  }
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("alignfirst: package.json is missing 'version'");
  return pkg.version;
}

function renderHelp(ctx: CommandContext): string {
  return `alignfirst — protocols, plans and docs in one command.

Usage:
  ${ctx.form} guide [<protocol>]
  ${ctx.form} ticket [<id>]
  ${ctx.form} sync [--auto-archive]
  ${ctx.form} plans <command>
  ${ctx.form} docmap [<arguments>]
  ${ctx.form} config [--json]
  ${ctx.form} DEVELOPERS.md
  ${ctx.form} setup [<options>]
  ${ctx.form} doctor
  ${ctx.form} --help
  ${ctx.form} --version
`;
}

function dispatch(ctx: CommandContext, command: string, args: string[]): number | Promise<number> {
  switch (command) {
    case "guide":
      return runGuide(ctx, args);
    case "ticket":
      return runTicket(ctx, args);
    case "sync":
      return runSync(ctx, args);
    case "plans":
      return runPlans(ctx, args);
    case "docmap":
      return runDocmap(ctx, args);
    case "config":
      return runConfig(ctx, args);
    case "DEVELOPERS.md":
      return runDevelopers(ctx, args);
    case "setup":
      return runSetup(ctx, args);
    case "doctor":
      return runDoctor(ctx, args);
    default:
      throw new CliError(`Error: unknown command "${command}".\n\n${renderHelp(ctx)}`);
  }
}
