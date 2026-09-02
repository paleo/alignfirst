import { readFileSync } from "node:fs";
import { runArchive, runAutoArchive } from "./archive.js";
import { runCheck } from "./check.js";
import { CliError, type CliContext } from "./context.js";
import { runSetup } from "./setup.js";
import { runSync } from "./sync.js";

const HELP = `plans-share — share the .plans directory through a team plans repository.

Usage:
  plans-share setup <dir> --folder <name>
  plans-share sync [--auto-archive]
  plans-share archive <ticket-id | path>
  plans-share auto-archive
  plans-share check
  plans-share --help | --version

setup   Link .plans to <dir>/<name>/, where <dir> is an existing clone of the plans
        repository, migrating any existing .plans content. Once per machine; re-run
        with the new location if the clone moves.
sync    Pull, commit, and push the plans repository. With --auto-archive, archive
        stale plans before committing.
archive Move one ticket directory to .plans/_archives/.
auto-archive
        Move stale ticket directories and no-ticket session files to .plans/_archives/.
check   Report whether .plans is shared through a team plans repository or a plain
        local directory; exit 1 when it is unusable. For automation, e.g. a
        workspace preSetup callback.

PLANS_SHARE_ARCHIVE_DAYS sets the auto-archive threshold in days (default 7).
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
        runSync(ctx, rest);
        return 0;
      case "archive":
        runArchive(ctx, rest);
        return 0;
      case "auto-archive":
        runAutoArchive(ctx);
        return 0;
      case "check":
        runCheck(ctx);
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
  if (pkg.version === undefined) throw new Error("plans-share: package.json is missing 'version'");
  return pkg.version;
}
