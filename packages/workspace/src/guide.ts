import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REGISTRY_SUBDIR } from "./slots.js";

// One combined operating guide for the `workspace` and `dev` scripts, printed by `workspace
// --guide` (only the `workspace` script knows the full config — `sharedDirs` included). The prose
// lives in `templates/guide.md` (easy to edit); the command tables stay here so we can align their
// `#` comments vertically whatever the package-manager prefix length. Tags in the template:
//   {{COMMANDS:<name>}} — an aligned command block (see commandBlocks)
//   {{SNIPPET:drive-dev}} — the multi-step "drive the dev server elsewhere" shell snippet
//   {{WS}} / {{DEV}} / {{DEV_BASE}} — inline command prefixes
//   {{RUNTIME_DIR}} / {{REGISTRY_SUBDIR}} — the per-worktree runtime dir + its registry sub-dir
//   {{LAYOUT:shared}} — the shared-dirs line, listing the configured `sharedDirs` by name

interface ScriptInvocation {
  /** Run with no forwarded args, e.g. `npm run dev`. */
  base: string;
  /** Prefix before forwarded args, e.g. `npm run dev --`. */
  withArgs: string;
}

export interface PackageManagerCommands {
  workspace: ScriptInvocation;
  dev: ScriptInvocation;
}

export interface GuideLayout {
  /** The per-worktree runtime dir, relative to the worktree root (config `runtimeDir`, e.g. `.local-wt`). */
  runtimeDir: string;
  /** The shared (symlinked-from-main) dir names (config `sharedDirs`). */
  sharedDirs: string[];
}

interface CommandRow {
  command: string;
  comment: string;
}

// Pad every command to the longest one so the `#` comments line up, whatever the
// package-manager prefix length (npm's `run … --` vs a bare `pnpm dev`).
function renderRows(rows: CommandRow[]): string {
  const width = Math.max(...rows.map((row) => row.command.length));
  return rows.map((row) => `${row.command.padEnd(width)}  # ${row.comment}`).join("\n");
}

// Like renderRows, but tolerates bare comment-only lines (rendered verbatim, never padded)
// interleaved between commands.
function renderSnippet(lines: (CommandRow | string)[]): string {
  const commands = lines.filter((line): line is CommandRow => typeof line !== "string");
  const width = Math.max(...commands.map((row) => row.command.length));
  return lines
    .map((line) =>
      typeof line === "string" ? line : `${line.command.padEnd(width)}  # ${line.comment}`,
    )
    .join("\n");
}

function commandBlocks(pm: PackageManagerCommands): Record<string, CommandRow[]> {
  const ws = pm.workspace.withArgs;
  const dev = pm.dev.withArgs;
  return {
    setup: [
      {
        command: `${ws} setup my-branch -c`,
        comment: "new branch + worktree (dedup: appends -2, -3…)",
      },
      {
        command: `${ws} setup my-branch -c --from origin/main`,
        comment: "new branch based on another ref",
      },
      { command: `${ws} setup my-branch`, comment: "new worktree on an existing branch" },
      {
        command: `${ws} setup`,
        comment: "set up the current worktree (idempotent; bootstrap + retry path)",
      },
      {
        command: `${ws} wait --slot 8110`,
        comment: "block until ready (exit 0) or failed (exit 1)",
      },
    ],
    recovery: [
      {
        command: `${ws} setup --wait`,
        comment: "retry the finalize step, block until READY/FAILED",
      },
    ],
    inspect: [
      {
        command: `${ws} list`,
        comment: "all registered workspaces (slot, status, branch, path, created)",
      },
      {
        command: `${ws} status`,
        comment: "current worktree summary (ports, branch, readiness, dev-server)",
      },
      {
        command: `${ws} status ../my-worktree`,
        comment: "another worktree (by path or dir name; or --slot <port>)",
      },
    ],
    remove: [
      { command: `${ws} remove`, comment: "remove the current worktree (run from inside it)" },
      {
        command: `${ws} remove ../my-worktree`,
        comment: "remove another (by path or dir name; or --slot <port>)",
      },
    ],
    prune: [
      {
        command: `${ws} prune`,
        comment: "stop orphans' dev-servers, drop registry entries, run `git worktree prune`",
      },
    ],
    dev: [
      {
        command: pm.dev.base,
        comment: "foreground; streams logs; CTRL+C stops (attaches if already running here)",
      },
      { command: `${dev} up`, comment: "start in the background (this worktree)" },
      {
        command: `${dev} restart`,
        comment: "stop this worktree's dev-server if running, then start in background",
      },
      {
        command: `${dev} status`,
        comment: "report whether this worktree's dev-server is UP or DOWN",
      },
      { command: `${dev} down`, comment: "stop the dev-server (this worktree only)" },
      { command: `${dev} list`, comment: "list active dev-servers across all worktrees" },
      { command: `${dev} down --all`, comment: "stop every active dev-server" },
      {
        command: `${dev} up --evict`,
        comment: "if the cap is full, evict the oldest dev-server and start",
      },
    ],
  };
}

function driveDevSnippet(pm: PackageManagerCommands): string {
  const dev = pm.dev.withArgs;
  return renderSnippet([
    { command: "git worktree list", comment: "1. find the worktree directory" },
    { command: `cd <worktree-dir> && ${dev} up`, comment: "2. start in the background" },
    "# 3. read the log file (path printed on start) to confirm startup and find URLs",
    { command: `${dev} down`, comment: "4. stop when done (same directory)" },
  ]);
}

function renderSharedLayout(sharedDirs: string[]): string {
  if (sharedDirs.length === 0) {
    return "- No dirs are shared across worktrees.";
  }
  const names = sharedDirs.map((dir) => `\`${dir}/\``).join(", ");
  return `- Shared across worktrees, symlinked from the main worktree: ${names}.`;
}

export function renderGuide(pm: PackageManagerCommands, layout: GuideLayout): string {
  const template = readFileSync(new URL("../templates/guide.md", import.meta.url), "utf-8");
  let out = template;
  for (const [name, rows] of Object.entries(commandBlocks(pm))) {
    out = out.replaceAll(`{{COMMANDS:${name}}}`, renderRows(rows));
  }
  return out
    .replaceAll("{{SNIPPET:drive-dev}}", driveDevSnippet(pm))
    .replaceAll("{{DEV_BASE}}", pm.dev.base)
    .replaceAll("{{WS}}", pm.workspace.withArgs)
    .replaceAll("{{DEV}}", pm.dev.withArgs)
    .replaceAll("{{RUNTIME_DIR}}", layout.runtimeDir)
    .replaceAll("{{REGISTRY_SUBDIR}}", REGISTRY_SUBDIR)
    .replaceAll("{{LAYOUT:shared}}", renderSharedLayout(layout.sharedDirs))
    .trimEnd();
}

export function printGuide(layout: GuideLayout, cwd: string = process.cwd()): void {
  console.log(renderGuide(detectPackageManager(cwd), layout));
}

// Mirror docmap's lockfile walk. These scripts are always wired as project scripts (the package
// is a dev dependency), so there is no global-install fallback — default to npm when unsure.
function detectPackageManager(cwd: string): PackageManagerCommands {
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
