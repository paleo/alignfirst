import { type LaunchEvidence, readLaunchEvidence } from "@alignfirst/docmap/invocation";
import { homedir } from "node:os";

import { runCode } from "./code/code-cli.js";
import {
  createExecutableModelResolver,
  createModelLists,
  type ExecutableModelResolver,
  type ModelLists,
} from "./code/models.js";
import { type QuotaReader, readQuota } from "./code/quota.js";
import { type CommandForms, resolveCommandForms } from "./command-form.js";
import { ASSISTANT_HARNESS_VARIABLE, HARNESSES } from "./assistant-harness.js";
import { loadConfig } from "./config.js";
import { createMemory, type Memory } from "./memory/memory.js";
import { errorMessage } from "./errors.js";
import { runGuide } from "./guide/guide-cli.js";
import type { Output } from "./output.js";
import { readPackageVersion } from "./package-version.js";
import { runProject } from "./project/project-cli.js";

export interface MainOptions {
  argv?: string[];
  evidence?: LaunchEvidence;
  stdout?: Output;
  stderr?: Output;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  alignfirstCommand?: string[];
  modelResolver?: ExecutableModelResolver;
  modelLists?: ModelLists;
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
  modelLists: ModelLists;
  quotaReader: QuotaReader;
  memory: Memory;
}

export async function main(options?: MainOptions): Promise<number> {
  const ctx = resolveContext(options);
  try {
    return await runCommand(ctx, options?.argv ?? process.argv);
  } finally {
    ctx.memory.close();
  }
}

async function runCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const [command, ...tokens] = argv.slice(2);
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
  try {
    if (command === "code")
      return await runCode(tokens, () => loadConfig(ctx.home, ctx.forms.alignfirst), ctx);
    const config = loadConfig(ctx.home, ctx.forms.alignfirst);
    if (command === "project") return runProject(tokens, config, ctx);
    return runGuide(tokens, config, ctx);
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function renderHelp(aligndev: string): string {
  const usage = renderUsageRows([
    [`${aligndev} code <command> [<options>]`, "Run a coding agent through AlignFirst protocols."],
    [
      `${aligndev} project <command> [<options>]`,
      "List projects, check their inventory, look up free ports.",
    ],
    [
      `${aligndev} guide [--channel <surface>] [<topic>]`,
      "Print the assistant's playbook and guides.",
    ],
    [`${aligndev} -h, --help`],
    [`${aligndev} -v, --version`],
  ]);
  return `aligndev — the AlignDev CLI.

Usage:
${usage}

Run \`${aligndev} <command> --help\` for the usage of a command.

The assistant's harness (${HARNESSES.join(", ")}) is ${ASSISTANT_HARNESS_VARIABLE} when set, else the
detected coding agent, else openclaw under OPENCLAW_SHELL=exec. It selects the playbook.

Config (optional): ~/.alignfirst/aligndev.settings.json. Each of code.profiles names a harness and
its native configuration; disabled: true hides one. The assistant's profile delegates to its
defaultAgentProfile; code.fallbackProfile serves an assistant without a profile or built-in
defaults. See \`${aligndev} code --help\` for the selection order.

Global assistant instructions (optional): ~/.alignfirst/ASSISTANTS.md. \`${aligndev} guide\` prints
them at the end of the dispatcher.
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
  const evidence = options?.evidence ?? {
    ...readLaunchEvidence(),
    env,
    cwd: options?.cwd ?? process.cwd(),
  };
  const forms = resolveCommandForms(env, evidence);
  const home = options?.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const memory = createMemory(home);
  return {
    cwd: options?.cwd ?? process.cwd(),
    env,
    home,
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    forms,
    alignfirstCommand: options?.alignfirstCommand ?? [
      forms.counterpart.executable,
      ...forms.counterpart.args,
    ],
    modelResolver: options?.modelResolver ?? createExecutableModelResolver({}, { memory }),
    modelLists: options?.modelLists ?? createModelLists(memory),
    quotaReader: options?.quotaReader ?? readQuota,
    memory,
  };
}
