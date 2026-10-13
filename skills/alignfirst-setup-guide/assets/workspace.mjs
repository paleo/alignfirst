// =============================================================================
// Reference: workspace.mjs
//
// Thin wrapper around `@alignfirst/workspace`. Search for "ADAPT" to find every
// project-specific field. The kernel (workspace registry, branch lifecycle,
// removal flow, CLI) lives in the package; this file only carries project
// knowledge. `workspace setup` allocates no port: the ports, the files that
// carry them and the infrastructure belong to dev-server.mjs.
// =============================================================================

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspace, helpers } from "@alignfirst/workspace";

await runWorkspace({
  // Required. The package re-spawns this script for the detached finalize phase, so it must know
  // where it lives. Leave this line as-is — `import.meta.url` always resolves to this file.
  workspaceScript: fileURLToPath(import.meta.url),

  // ADAPT (optional): absolute path to your dev-server script. On `workspace
  // remove`, the kernel shells out to `node <devServerScript> down` with cwd set
  // to the target worktree; `setup --full` runs its `setup`. Drop this field —
  // and `dev-server.mjs` itself — in a setup-only project.
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),

  // ADAPT: directories symlinked from the main worktree.
  sharedDirs: [".local", ".plans"],

  // Per-worktree runtime directory. The package writes the setup log
  // and dev-server logs under here.
  runtimeDir: ".local-wt",

  // ADAPT: the gitignored files that install, build or tests need. A file
  // carrying ports goes in `runFiles` (dev-server.mjs) instead; one path
  // belongs to one list only. Each entry declares a `source`:
  //   { kind: "mainWorktree", fallback } copy the main-worktree file when it exists,
  //                                       otherwise a committed fallback from this branch
  //   { kind: "committed", path: "..." }  copy a committed template (e.g. an
  //                                       .example) from the worktree's checkout
  //   { kind: "content", content }        inline string, or a sync/async function
  //                                       receiving the same context as `patch`
  // `patch` is optional — omit it to copy verbatim.
  // Omitting an entry leaves the linked worktree silently missing that file.
  gitignoredFiles: [
    // ADAPT: a verbatim copy, no `patch`. `optional: true` skips it (with a
    // warning) when absent.
    {
      path: ".vscode/settings.json",
      source: {
        kind: "mainWorktree",
        fallback: ".vscode/settings.example.json",
      },
      optional: true,
    },
  ],

  // ADAPT: Detached finalization step. Runs in the background after the
  // worktree is created and the foreground command has returned. Infrastructure
  // (database, seed) belongs in `setup` (dev-server.mjs).
  //
  // MUST BE IDEMPOTENT — `workspace setup` is the documented retry
  // path. Guard each block against pre-existing state so re-runs are no-ops.
  //
  // Run `npm install` first: any later failure then leaves a worktree with
  // usable node_modules, so `workspace setup` can re-import @alignfirst/workspace.
  finalizeWorkspace: async ({ currentWorktree }) => {
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
    execSync("npm run build", { stdio: "inherit", cwd: currentWorktree });
  },

  // ADAPT: destructive infrastructure teardown — typically `docker compose
  // down -v` to wipe volumes. Runs on `workspace remove`, `workspace prune`,
  // and orphan removal, whether or not `dev setup` ever succeeded. Drop on a
  // stack without infrastructure.
  //
  // MUST BE IDEMPOTENT — tolerate absent or partial infrastructure. May run
  // when the worktree is gone (orphan), so tear down by name. `docker compose
  // -p` finds the stack by its compose labels, from any directory and without a
  // compose file.
  purgeInfrastructure: ({ name, mainWorktree }) => {
    try {
      const project = helpers.composeProjectName(name);
      execFileSync("docker", ["compose", "-p", project, "down", "-v"], { stdio: "pipe" });
    } catch {
      // infra may already be gone
    }
    // ADAPT: the external resource `setup` recorded under the main worktree.
    const tunnelFile = join(mainWorktree, ".local-wt", "tunnels", name);
    if (existsSync(tunnelFile)) {
      try {
        closeDevTunnel(readFileSync(tunnelFile, "utf8"));
      } catch {
        // tunnel may already be closed
      }
      rmSync(tunnelFile, { force: true });
    }
  },

  // ADAPT. Do not list dev-server URLs here — the dev-server is not running yet
  // at this point. The worktree path is the useful pointer.
  formatSummary: ({ name, branch, currentWorktree, isMainWorktree }) => `
Workspace setup complete!
  Worktree type: ${isMainWorktree ? "main" : "linked"}
  Workspace:     ${name}
  Branch:        ${branch}
  Path:          ${currentWorktree}
`,
});
