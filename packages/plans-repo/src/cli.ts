import { readFileSync } from "node:fs";
import { CliError, type CliContext } from "./context.js";
import { runSetup } from "./setup.js";
import { runSync } from "./sync.js";

const HELP = `plans-repo — share the .plans directory through a team plans repository.

Usage:
  plans-repo setup <dir> --repo <url> --folder <name>
  plans-repo sync
  plans-repo --help | --version

setup   Clone the plans repository at <dir> (or reuse an existing clone), then link .plans
        to <dir>/<name>/, migrating any existing .plans content. Once per machine; re-run
        with the new location if the clone moves.
sync    Pull, commit, and push the plans repository.
`;

export interface MainOptions {
  argv?: string[];
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  cwd?: string;
  userAgent?: string;
}

export function main(options?: MainOptions): number {
  const argv = options?.argv ?? process.argv;
  const ctx: CliContext = {
    cwd: options?.cwd ?? process.cwd(),
    stdout: options?.stdout ?? process.stdout,
    stderr: options?.stderr ?? process.stderr,
    syncCommand: syncCommand(options?.userAgent ?? process.env.npm_config_user_agent ?? ""),
  };
  const [command, ...rest] = argv.slice(2);
  try {
    switch (command) {
      case "setup":
        runSetup(ctx, rest);
        return 0;
      case "sync":
        runSync(ctx);
        return 0;
      case "--version":
        ctx.stdout.write(`${readPackageVersion()}\n`);
        return 0;
      case "--help":
      case "-h":
      case undefined:
        ctx.stdout.write(HELP);
        return 0;
      default:
        throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      ctx.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// The consumer repo wires `plans:sync` to this bin, so suggest the script through the package
// manager that launched us (`npm_config_user_agent` is empty for a bare global binary).
function syncCommand(userAgent: string): string {
  if (userAgent.startsWith("pnpm")) return "pnpm plans:sync";
  if (userAgent.startsWith("yarn")) return "yarn plans:sync";
  if (userAgent.startsWith("bun")) return "bun run plans:sync";
  return "npm run plans:sync";
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("plans-repo: package.json is missing 'version'");
  return pkg.version;
}
