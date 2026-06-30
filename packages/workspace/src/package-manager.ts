import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PackageManagerCommands {
  workspace: ScriptInvocation;
  dev: ScriptInvocation;
}

export interface ScriptInvocation {
  /** Run with no forwarded args, e.g. `npm run dev`. */
  base: string;
  /** Prefix before forwarded args, e.g. `npm run dev --`. */
  withArgs: string;
}

/** A `workspace <args>` command string, prefixed for the detected package manager. */
export function wsCmd(args: string): string {
  return `${packageManagerCommands().workspace.withArgs} ${args}`;
}

/** A `dev <args>` command string, prefixed for the detected package manager. */
export function devCmd(args: string): string {
  return `${packageManagerCommands().dev.withArgs} ${args}`;
}

// The detected manager is stable for the whole CLI process (same repo, same lockfile), so detect
// once from the process cwd and cache it. No per-call cwd: every worktree of a repo resolves to the
// same manager, and a single CLI process never spans repos.
let cached: PackageManagerCommands | undefined;

export function packageManagerCommands(): PackageManagerCommands {
  cached ??= detectPackageManager(process.cwd());
  return cached;
}

// Mirror docmap's lockfile walk. These scripts are always wired as project scripts (the package
// is a dev dependency), so there is no global-install fallback — default to npm when unsure.
export function detectPackageManager(cwd: string): PackageManagerCommands {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return same("pnpm");
    if (existsSync(join(dir, "yarn.lock"))) return same("yarn run");
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
      return same("bun run");
    if (existsSync(join(dir, "package-lock.json"))) return npm();
    const parent = dirname(dir);
    if (parent === dir) return npm();
    dir = parent;
  }
}

// Only npm needs a `--` separator before forwarded args; every other manager passes them verbatim.
function npm(): PackageManagerCommands {
  return {
    workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
    dev: { base: "npm run dev", withArgs: "npm run dev --" },
  };
}

function same(prefix: string): PackageManagerCommands {
  return {
    workspace: { base: `${prefix} workspace`, withArgs: `${prefix} workspace` },
    dev: { base: `${prefix} dev`, withArgs: `${prefix} dev` },
  };
}
