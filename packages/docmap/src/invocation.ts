import { readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface Invocation {
  runtime: Runtime;
  manager?: PackageManager;
  launcher: "direct" | "packageRunner" | "projectScript";
  target: InvocationTarget;
  script?: VerifiedScript;
}

export type Runtime = "node" | "bun";
export type PackageManager = "npm" | "bun" | "pnpm" | "yarn";

export interface InvocationTarget {
  packageName: string;
  binaryName: string;
}

export interface VerifiedScript {
  name: string;
  directory: string;
  cwd: string;
}

export interface LaunchEvidence {
  runtime: Runtime;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  entryPoint?: string;
  executable: string;
  /** Immediate parent only; missing evidence deliberately disables script reconstruction. */
  parentArgv?: readonly string[];
}

export interface InvocationCommand {
  executable: string;
  /** Fixed argv before caller arguments, including a script's forwarding separator. */
  args: string[];
  base: string;
  withArgs: string;
}

/** Read once at the CLI boundary. No launcher inference from execPath or argv flags. */
export function readLaunchEvidence(): LaunchEvidence {
  return {
    runtime: process.versions.bun === undefined ? "node" : "bun",
    env: { ...process.env },
    cwd: process.cwd(),
    entryPoint: process.argv[1],
    executable: process.execPath,
    parentArgv: readParentArgv(process.ppid),
  };
}

function readParentArgv(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    // On platforms without procfs, retain a safe package runner rather than an ancestor script.
    return;
  }
}

export function resolveInvocation(target: InvocationTarget, evidence: LaunchEvidence): Invocation {
  const manager = identifyManager(evidence.env);
  const invocation: Invocation = {
    runtime: evidence.runtime,
    manager,
    launcher: manager === undefined ? "direct" : "packageRunner",
    target,
  };
  if (manager === undefined || isExplicitRunner(manager, evidence.env)) return invocation;
  const script = verifyScript(target, manager, evidence);
  return script === undefined ? invocation : { ...invocation, launcher: "projectScript", script };
}

function identifyManager(env: LaunchEvidence["env"]): PackageManager | undefined {
  const agent = env.npm_config_user_agent;
  for (const manager of ["bun", "pnpm", "yarn", "npm"] as const) {
    if (agent?.startsWith(`${manager}/`)) return manager;
  }
  // npm_execpath is launcher evidence, never a runtime executable to spawn.
  const exec = env.npm_execpath;
  if (exec === undefined) return;
  if (/[/\\]npm-cli\.js$/.test(exec)) return "npm";
  if (/[/\\]pnpm\.(?:c?js|mjs)$/.test(exec)) return "pnpm";
  if (/[/\\]yarn(?:\.js|\.cjs)?$/.test(exec)) return "yarn";
}

function isExplicitRunner(manager: PackageManager, env: LaunchEvidence["env"]): boolean {
  if (env.npm_command === "exec") return true;
  return (manager === "pnpm" || manager === "yarn") && env.npm_command === "dlx";
}

function verifyScript(
  target: InvocationTarget,
  manager: PackageManager,
  evidence: LaunchEvidence,
): VerifiedScript | undefined {
  const { env } = evidence;
  const name = env.npm_lifecycle_event;
  const script = env.npm_lifecycle_script;
  const manifest = env.npm_package_json;
  if (
    name === undefined ||
    name === "" ||
    name.startsWith("-") ||
    script === undefined ||
    manifest === undefined
  )
    return;
  if (!isScriptMode(manager, env.npm_command)) return;
  const manifestPath = resolve(evidence.cwd, manifest);
  const directory = dirname(manifestPath);
  if (!manifestHasScript(manifestPath, name, script)) return;
  const tokens = transparentTokens(script);
  if (tokens === undefined || !launchesEntry(tokens, directory, target, evidence)) return;
  if (!ownsScript(manager, name, tokens, evidence.parentArgv)) return;
  return { name, directory, cwd: evidence.cwd };
}

function isScriptMode(manager: PackageManager, command: string | undefined): boolean {
  if (manager === "npm") return command === "run" || command === "run-script";
  if (manager === "bun") return command === "run-script";
  // pnpm and Yarn Classic do not consistently export npm_command for run scripts.
  return command === undefined || command === "run" || command === "run-script";
}

function manifestHasScript(path: string, name: string, script: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) return false;
    const scripts = manifest.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      Object.hasOwn(scripts, name) &&
      Reflect.get(scripts, name) === script
    );
  } catch {
    return false;
  }
}

/** Deliberately only literal words and quoted paths, not a shell language. */
function transparentTokens(script: string): string[] | undefined {
  const tokens: string[] = [];
  const pattern = /(?:"([^"\\$`\n]*)"|'([^'\n]*)'|([\w./:@+-]+))(?:\s+|$)/gy;
  let position = 0;
  while (position < script.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(script);
    if (match === null) return;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    position = pattern.lastIndex;
  }
  return tokens.length === 0 ? undefined : tokens;
}

function launchesEntry(
  tokens: string[],
  directory: string,
  target: InvocationTarget,
  evidence: LaunchEvidence,
): boolean {
  if (evidence.entryPoint === undefined) return false;
  const entry = canonical(resolve(evidence.cwd, evidence.entryPoint));
  if (entry === undefined) return false;
  const [command, file] = tokens;
  if (tokens.length === 2 && (command === "node" || command === "bun")) {
    return canonical(resolve(directory, file)) === entry;
  }
  if (tokens.length !== 1) return false;
  if (command.includes("/") || isAbsolute(command)) {
    return canonical(resolve(directory, command)) === entry;
  }
  if (command !== target.binaryName) return false;
  const local = canonical(join(directory, "node_modules", ".bin", command));
  if (local === entry) return true;
  return (
    evidence.env.PATH?.split(delimiter).some(
      (path) => canonical(resolve(directory, path, command)) === entry,
    ) ?? false
  );
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return;
  }
}

function ownsScript(
  manager: PackageManager,
  name: string,
  tokens: string[],
  parent: readonly string[] | undefined,
): boolean {
  if (parent === undefined) return false;
  const shellIndex = parent.indexOf("-c");
  if (shellIndex !== -1 && /^(?:sh|bash|dash|zsh)$/.test(basename(parent[0]))) {
    const actual = transparentTokens(parent[shellIndex + 1] ?? "");
    return actual !== undefined && tokens.every((token, index) => actual[index] === token);
  }
  // npm sets a process title; Bun/pnpm/yarn generally keep ordinary argv.
  if (manager === "npm" && parent.length === 1) return parent[0] === `npm run ${name}`;
  const runner = parent.findIndex(
    (arg) =>
      basename(arg).replace(/\.(?:exe|cjs|js|mjs)$/, "") === manager ||
      (manager === "npm" && basename(arg) === "npm-cli.js"),
  );
  if (runner === -1) return false;
  const args = parent.slice(runner + 1).filter((arg) => arg !== "--bun");
  return (args[0] === "run" || args[0] === "run-script") && args[1] === name;
}

/** Self follow-ups may retain their verified script. Counterparts and subprocesses use packageCommand. */
export function invocationCommand(invocation: Invocation): InvocationCommand {
  if (invocation.script !== undefined && invocation.manager !== undefined) {
    if (invocation.runtime !== "bun" || invocation.manager === "bun") {
      return scriptCommand(invocation.manager, invocation.script.name, {
        runtime: invocation.runtime,
        directory: invocation.script.directory,
        cwd: invocation.script.cwd,
      });
    }
  }
  return packageCommand(invocation, invocation.target);
}

export interface ScriptCommandOptions {
  runtime?: Runtime;
  directory?: string;
  cwd?: string;
}

/** Also usable for known configured scripts (workspace's lockfile/default-manager policy). */
export function scriptCommand(
  manager: PackageManager,
  name: string,
  options: ScriptCommandOptions = {},
): InvocationCommand {
  const selected = options.runtime === "bun" ? "bun" : manager;
  const location =
    options.directory !== undefined && options.directory !== options.cwd
      ? [
          selected === "npm" ? "--prefix" : selected === "pnpm" ? "--dir" : "--cwd",
          options.directory,
        ]
      : [];
  const runtime = selected === "bun" && options.runtime === "bun" ? ["--bun"] : [];
  return createCommand(selected, [...runtime, ...location, "run", name], selected === "npm");
}

/** A version override forces a package runner; it never fabricates a project script. */
export function packageCommand(
  invocation: Invocation,
  target: InvocationTarget,
  packageSpec?: string,
): InvocationCommand {
  const spec = packageSpec ?? target.packageName;
  if (invocation.runtime === "bun") return createCommand("bunx", ["--bun", spec]);
  switch (invocation.manager) {
    case "npm":
      return createCommand("npx", ["-y", spec]);
    case "bun":
      return createCommand("bunx", [spec]);
    case "pnpm":
      return createCommand("pnpm", ["dlx", spec]);
    case "yarn":
      return createCommand("yarn", ["dlx", spec]);
    default:
      return packageSpec === undefined
        ? createCommand(target.binaryName)
        : createCommand("npx", ["-y", spec]);
  }
}

export function createCommand(
  executable: string,
  args: readonly string[] = [],
  forwardSeparator = false,
): InvocationCommand {
  const forwarded = forwardSeparator ? [...args, "--"] : [...args];
  return {
    executable,
    args: forwarded,
    base: renderWords([executable, ...args]),
    withArgs: renderWords([executable, ...forwarded]),
  };
}

export function renderCommand(command: InvocationCommand, args: readonly string[] = []): string {
  return args.length === 0
    ? command.base
    : renderWords([command.executable, ...command.args, ...args]);
}

function renderWords(words: readonly string[]): string {
  return words
    .map((word) => (/^[\w./:@+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`))
    .join(" ");
}
