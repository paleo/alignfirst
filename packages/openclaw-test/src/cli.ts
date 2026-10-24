import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import {
  createCommand,
  type Invocation,
  type Runtime,
  scriptCommand,
} from "@alignfirst/docmap/invocation";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBus } from "./bus.js";
import { envCommand, runCommand } from "./env-cli.js";
import { main as runnerMain } from "./runner.js";
import { cliCommand, resolveCliInvocation } from "./invocation.js";

// `dist/cli.js` ships under `<package>/dist/`; one level up from its dir is the package root.
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INIT_SCRIPTS: Record<string, string> = {
  "env:build": "openclaw-test env build",
  "env:up": "openclaw-test env up",
  "env:down": "openclaw-test env down",
  e2e: "openclaw-test run",
};

export async function dispatch(
  argv: string[],
  invocation: Invocation = resolveCliInvocation(),
): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      await initCommand(rest[0], invocation);
      return;
    case "env":
      await envCommand(PACKAGE_DIR, rest, invocation);
      return;
    case "run":
      await runCommand(PACKAGE_DIR, rest, invocation);
      return;
    case "bus":
      startBus();
      return;
    case "runner":
      await runnerMain(rest);
      return;
    default:
      usage(invocation);
  }
}

async function initCommand(
  targetDirRaw: string | undefined,
  invocation: Invocation,
): Promise<void> {
  if (!targetDirRaw) usage(invocation);
  const target = resolve(process.cwd(), targetDirRaw);
  const templatesDir = join(PACKAGE_DIR, "templates");
  await mkdir(target, { recursive: true });
  const entries = await readdir(templatesDir);
  for (const name of entries) {
    await copyFile(join(templatesDir, name), join(target, name));
    console.log(`copied ${name} -> ${join(target, name)}`);
  }
  await addScriptsToPackageJson(target, invocation);
  printNextSteps(target, invocation);
}

async function addScriptsToPackageJson(target: string, invocation: Invocation): Promise<void> {
  const pkgPath = join(target, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    console.log(
      `no package.json found — run \`${invocation.runtime === "bun" ? "bun" : (invocation.manager ?? "npm")} init\`, then add the scripts manually (see README)`,
    );
    return;
  }
  let pkg: PackageJsonScripts;
  try {
    pkg = JSON.parse(raw) as PackageJsonScripts;
  } catch {
    console.error(
      `${pkgPath} is not valid JSON — fix it, then add the scripts manually (see README)`,
    );
    return;
  }
  const added = addInitScripts(pkg, invocation.runtime);
  if (added.length === 0) {
    console.log("package.json scripts already present");
    return;
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`);
  console.log(`added scripts to package.json: ${added.join(", ")}`);
}

export interface PackageJsonScripts {
  scripts?: Record<string, string>;
}

export function addInitScripts(pkg: PackageJsonScripts, runtime: Runtime = "node"): string[] {
  pkg.scripts ??= {};
  const scripts = pkg.scripts;
  const added: string[] = [];
  for (const [name, command] of Object.entries(INIT_SCRIPTS)) {
    if (scripts[name] !== undefined) continue;
    scripts[name] =
      runtime === "bun"
        ? command.replace("openclaw-test", "bun ./node_modules/.bin/openclaw-test")
        : command;
    added.push(name);
  }
  return added;
}

function printNextSteps(target: string, invocation: Invocation): void {
  const dependencies =
    "@alignfirst/openclaw-test @alignfirst/openclaw-channel-mock-core" +
    " @alignfirst/openclaw-discord-mock @alignfirst/openclaw-slack-mock openclaw";
  // The consumer image intentionally uses npm ci, even on a Bun-only host.
  const install =
    invocation.runtime === "bun"
      ? `docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache -v "$PWD:/app" -w /app node:26 npm install -D ${dependencies}`
      : `npm i -D ${dependencies}`;
  const build = scriptCommand(invocation.manager ?? "npm", "env:build", {
    runtime: invocation.runtime,
  }).base;
  console.log(
    "\nNext steps (in the target directory):\n" +
      `  cd ${createCommand(target).base}\n` +
      `  1. ${install}\n` +
      "     This prepares package-lock.json for the Node/npm consumer image.\n" +
      "  2. cp .env.local.example .env.local   # then fill it in\n" +
      `  3. ${build}`,
  );
}

function usage(invocation: Invocation): never {
  console.error(
    `usage: ${cliCommand(invocation)} <init|env|run|bus|runner> [args]\n\n` +
      "  init <target-dir>      copy templates into target dir\n" +
      "  env <build|up|down>    drive the Compose stack (host-side)\n" +
      "  run [flags] [...]      run scenarios against the stack (host-side)\n" +
      "  bus                    start the bus HTTP server (inside container)\n" +
      "  runner [flags] [...]   execute scenarios (inside container)\n",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  dispatch(process.argv.slice(2)).catch((err) => {
    console.error("openclaw-test crash:", err);
    process.exit(1);
  });
}
