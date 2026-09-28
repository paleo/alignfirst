import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { DEFAULT_ALIGNFIRST_COMMAND } from "./alignfirst-cli.js";
import { runCode } from "./code/code-cli.js";
import { type ExecutableModelResolver, resolveExecutableModel } from "./code/models.js";
import { type QuotaReader, readQuota } from "./code/quota.js";
import { type AldevConfig, loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { runGuide } from "./guide/guide-cli.js";
import type { Output } from "./output.js";
import { runProject } from "./project/project-cli.js";

const HELP = `aldev — the AlignFirst Dev Kit CLI.

Usage:
  aldev code <command> [<options>]      Run a coding agent through AlignFirst protocols.
  aldev project <command> [<options>]   List projects, check their inventory, claim port ranges.
  aldev guide [<topic>]                 Print the assistant's playbook and guides.
  aldev -h, --help
  aldev -v, --version

Run \`aldev <command> --help\` for the usage of a command.

Config: ~/.config/alignfirst/aldev.json. An absent file means no configuration.
`;

export interface MainOptions {
  argv?: string[];
  stdout?: Output;
  stderr?: Output;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  alignfirstCommand?: string[];
  modelResolver?: ExecutableModelResolver;
  quotaReader?: QuotaReader;
}

interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: Output;
  stderr: Output;
  alignfirstCommand: string[];
  modelResolver: ExecutableModelResolver;
  quotaReader: QuotaReader;
}

export async function main(options?: MainOptions): Promise<number> {
  const ctx = resolveContext(options);
  const [command, ...tokens] = (options?.argv ?? process.argv).slice(2);
  if (command === "--help" || command === "-h") {
    ctx.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    ctx.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (command !== "code" && command !== "project" && command !== "guide") {
    const error =
      command === undefined ? "Error: no command given." : `Error: unknown command "${command}".`;
    ctx.stderr.write(`${error}\n\n${HELP}`);
    return 1;
  }
  let config: AldevConfig;
  try {
    config = loadConfig(ctx.home);
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
  if (command === "code") return runCode(tokens, config, ctx);
  if (command === "project") return runProject(tokens, config, ctx);
  return runGuide(tokens, config, ctx);
}

function resolveContext(options: MainOptions | undefined): CliContext {
  const env = options?.env ?? process.env;
  return {
    cwd: options?.cwd ?? process.cwd(),
    env,
    home: options?.home ?? env.HOME ?? env.USERPROFILE ?? homedir(),
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    alignfirstCommand: options?.alignfirstCommand ?? DEFAULT_ALIGNFIRST_COMMAND,
    modelResolver: options?.modelResolver ?? resolveExecutableModel,
    quotaReader: options?.quotaReader ?? readQuota,
  };
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("aldev: package.json is missing 'version'");
  return pkg.version;
}
