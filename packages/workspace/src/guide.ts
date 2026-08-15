import { readFileSync } from "node:fs";
import { type PackageManagerCommands, detectPackageManager } from "./package-manager.js";
import { REGISTRY_SUBDIR } from "./workspaces.js";

// One combined operating guide for the `workspace` and `dev` scripts, printed by `workspace
// --guide` (only the `workspace` script knows the full config — `sharedDirs` included). The prose
// lives in `templates/guide.md` (easy to edit); the command tables stay here so we can align their
// `#` comments vertically whatever the package-manager prefix length. Tags in the template:
//   {{COMMANDS:<name>}} — an aligned command block (see commandBlocks)
//   {{SNIPPET:drive-dev}} — the multi-step "drive the dev server elsewhere" shell snippet
//   {{WS}} / {{DEV}} / {{DEV_BASE}} — inline command prefixes
//   {{RUNTIME_DIR}} / {{REGISTRY_SUBDIR}} — the per-worktree runtime dir + its registry sub-dir
//   {{LAYOUT:shared}} — the shared-dirs line, listing the configured `sharedDirs` by name
//   {{#DEV}}…{{/DEV}} / {{#PORTS}}…{{/PORTS}} — kept when the feature is configured, stripped
//     otherwise ({{^…}} for the reverse). Markers own their line.

export interface GuideLayout {
  /** The per-worktree runtime dir, relative to the worktree root (config `runtimeDir`, e.g. `.local-wt`). */
  runtimeDir: string;
  /** The shared (symlinked-from-main) dir names (config `sharedDirs`). */
  sharedDirs: string[];
  /** `true` when the config declares `devServerScript`. */
  hasDevServer: boolean;
  /** `true` when the config declares `ports`. */
  hasPorts: boolean;
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

function commandBlocks(
  pm: PackageManagerCommands,
  layout: GuideLayout,
): Record<string, CommandRow[]> {
  const ws = pm.workspace.withArgs;
  const dev = pm.dev.withArgs;
  return {
    setup: [
      {
        command: `${ws} setup -c my-branch`,
        comment: "new branch + worktree (add --dedupe to auto-suffix a taken name)",
      },
      {
        command: `${ws} setup -c my-branch --from origin/main`,
        comment: "new branch based on another ref",
      },
      {
        command: `${ws} setup -c my-branch -d`,
        comment: "return immediately; join with `wait`",
      },
      { command: `${ws} setup my-branch`, comment: "new worktree on an existing branch" },
      {
        command: `${ws} setup`,
        comment: "set up the current worktree (idempotent; bootstrap + retry path)",
      },
    ],
    recovery: [
      {
        command: `${ws} setup`,
        comment: "retry the finalize step; blocks until READY/FAILED",
      },
    ],
    inspect: [
      {
        command: `${ws} list`,
        comment: "all registered workspaces (name, status, branch, path, created)",
      },
      {
        command: `${ws} status`,
        comment: `current worktree summary (branch, readiness${summaryExtras(layout)})`,
      },
      {
        command: `${ws} status ../my-worktree`,
        comment: "another worktree (by path or dir name)",
      },
    ],
    remove: [
      { command: `${ws} remove`, comment: "remove the current worktree (run from inside it)" },
      {
        command: `${ws} remove ../my-worktree`,
        comment: "remove another (by path or dir name)",
      },
    ],
    prune: [
      {
        command: `${ws} prune`,
        comment: layout.hasDevServer
          ? "stop orphans' dev-servers, drop registry entries, run `git worktree prune`"
          : "drop orphans' registry entries, then run `git worktree prune`",
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

function summaryExtras(layout: GuideLayout): string {
  const extras = [
    layout.hasPorts ? "ports" : undefined,
    layout.hasDevServer ? "dev-server" : undefined,
  ];
  return extras
    .filter((extra) => extra !== undefined)
    .map((extra) => `, ${extra}`)
    .join("");
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
  let out = applySection(template, "DEV", layout.hasDevServer);
  out = applySection(out, "PORTS", layout.hasPorts);
  for (const [name, rows] of Object.entries(commandBlocks(pm, layout))) {
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

/** Keeps or strips one `{{#NAME}}…{{/NAME}}` (or `{{^NAME}}…{{/NAME}}`) block. Markers own their line. */
function applySection(text: string, name: string, present: boolean): string {
  const block = new RegExp(
    `^\\{\\{([#^])${name}\\}\\}\\n([\\s\\S]*?)^\\{\\{/${name}\\}\\}\\n`,
    "gm",
  );
  return text.replace(block, (_, sigil: string, body: string) =>
    (sigil === "#") === present ? body : "",
  );
}

export function printGuide(layout: GuideLayout, cwd: string = process.cwd()): void {
  console.log(renderGuide(detectPackageManager(cwd), layout));
}
