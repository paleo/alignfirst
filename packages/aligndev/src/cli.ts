import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { runCode } from "./code/code-cli.js";
import { CODING_AGENTS } from "./code/coding-agent.js";
import { type ExecutableModelResolver, resolveExecutableModel } from "./code/models.js";
import { type QuotaReader, readQuota } from "./code/quota.js";
import { type CommandForms, resolveCommandForms } from "./command-form.js";
import { type AligndevConfig, loadConfig, missingConfigMessage, PLATFORMS } from "./config.js";
import { errorMessage } from "./errors.js";
import { runGuide } from "./guide/guide-cli.js";
import type { Output } from "./output.js";
import { runProject } from "./project/project-cli.js";

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
  forms: CommandForms;
  alignfirstCommand: string[];
  modelResolver: ExecutableModelResolver;
  quotaReader: QuotaReader;
}

export async function main(options?: MainOptions): Promise<number> {
  const ctx = resolveContext(options);
  const [command, ...tokens] = (options?.argv ?? process.argv).slice(2);
  if (command === "--help" || command === "-h") {
    ctx.stdout.write(renderHelp(ctx.forms.aligndev));
    return 0;
  }
  if (command === "--version" || command === "-v") {
    ctx.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (command !== "code" && command !== "project" && command !== "guide") {
    const error =
      command === undefined ? "Error: no command given." : `Error: unknown command "${command}".`;
    ctx.stderr.write(`${error}\n\n${renderHelp(ctx.forms.aligndev)}`);
    return 1;
  }
  let config: AligndevConfig | undefined;
  try {
    config = loadConfig(ctx.home);
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
  if (command === "project") return runProject(tokens, config, ctx);
  if (config === undefined) {
    ctx.stderr.write(`${missingConfigMessage(ctx.home)}\n`);
    return 1;
  }
  if (command === "code") return runCode(tokens, config, ctx);
  return runGuide(tokens, config, ctx);
}

function renderHelp(aligndev: string): string {
  const usage = renderUsageRows([
    [`${aligndev} code <command> [<options>]`, "Run a coding agent through AlignFirst protocols."],
    [
      `${aligndev} project <command> [<options>]`,
      "List projects, check their inventory, claim port ranges.",
    ],
    [`${aligndev} guide [<topic>]`, "Print the assistant's playbook and guides."],
    [`${aligndev} -h, --help`],
    [`${aligndev} -v, --version`],
  ]);
  return `aligndev — the AlignFirst Dev Kit CLI.

Usage:
${usage}

Run \`${aligndev} <command> --help\` for the usage of a command.

Config: ~/.alignfirst/aligndev.config.json, with "platform" (${PLATFORMS.join(" or ")}) and
"code.agent" (${CODING_AGENTS.join(" or ")}). \`${aligndev} code\` and \`${aligndev} guide\` require it.
`;
}

// Each row is a command, optionally followed by its description in an aligned column.
function renderUsageRows(rows: [command: string, description?: string][]): string {
  const width = Math.max(...rows.map(([command]) => command.length)) + 3;
  return rows
    .map(([command, description]) =>
      description === undefined ? `  ${command}` : `  ${command.padEnd(width)}${description}`,
    )
    .join("\n");
}

function resolveContext(options: MainOptions | undefined): CliContext {
  const env = options?.env ?? process.env;
  const forms = resolveCommandForms(env);
  return {
    cwd: options?.cwd ?? process.cwd(),
    env,
    home: options?.home ?? env.HOME ?? env.USERPROFILE ?? homedir(),
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    forms,
    alignfirstCommand: options?.alignfirstCommand ?? forms.alignfirst.split(" "),
    modelResolver: options?.modelResolver ?? resolveExecutableModel,
    quotaReader: options?.quotaReader ?? readQuota,
  };
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("aligndev: package.json is missing 'version'");
  return pkg.version;
}
