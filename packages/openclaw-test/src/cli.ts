import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBus } from "./bus.js";
import { envCommand, runCommand } from "./env-cli.js";
import { main as runnerMain } from "./runner.js";

// `dist/cli.js` ships under `<package>/dist/`; one level up from its dir is the package root.
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INIT_SCRIPTS: Record<string, string> = {
  "env:build": "openclaw-test env build",
  "env:up": "openclaw-test env up",
  "env:down": "openclaw-test env down",
  e2e: "openclaw-test run",
};

export async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      await initCommand(rest[0]);
      return;
    case "env":
      await envCommand(PACKAGE_DIR, rest);
      return;
    case "run":
      await runCommand(PACKAGE_DIR, rest);
      return;
    case "bus":
      startBus();
      return;
    case "runner":
      await runnerMain(rest);
      return;
    default:
      usage();
  }
}

async function initCommand(targetDirRaw: string | undefined): Promise<void> {
  if (!targetDirRaw) usage();
  const target = resolve(process.cwd(), targetDirRaw);
  const templatesDir = join(PACKAGE_DIR, "templates");
  await mkdir(target, { recursive: true });
  const entries = await readdir(templatesDir);
  for (const name of entries) {
    await copyFile(join(templatesDir, name), join(target, name));
    console.log(`copied ${name} -> ${join(target, name)}`);
  }
  await addScriptsToPackageJson(target);
  printNextSteps();
}

async function addScriptsToPackageJson(target: string): Promise<void> {
  const pkgPath = join(target, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    console.log(
      "no package.json found — run `npm init`, then add the scripts manually (see README)",
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
  const added = addInitScripts(pkg);
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

export function addInitScripts(pkg: PackageJsonScripts): string[] {
  pkg.scripts ??= {};
  const scripts = pkg.scripts;
  const added: string[] = [];
  for (const [name, command] of Object.entries(INIT_SCRIPTS)) {
    if (scripts[name] !== undefined) continue;
    scripts[name] = command;
    added.push(name);
  }
  return added;
}

function printNextSteps(): void {
  console.log(
    "\nNext steps:\n" +
      "  1. npm i -D @paleo/openclaw-test @paleo/openclaw-channel-mock-core" +
      " @paleo/openclaw-discord-mock @paleo/openclaw-slack-mock openclaw\n" +
      "  2. cp .env.local.example .env.local   # then fill it in\n" +
      "  3. npm run env:build",
  );
}

function usage(): never {
  console.error(
    "usage: openclaw-test <init|env|run|bus|runner> [args]\n\n" +
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
