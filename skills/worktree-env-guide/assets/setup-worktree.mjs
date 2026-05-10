// =============================================================================
// Reference: setup-worktree.mjs
//
// Thin wrapper around `@paleo/worktree-env`. Search for "ADAPT" to find every
// project-specific field. The kernel (slot registry, port math, branch
// lifecycle, removal flow, CLI) lives in the package; this file only carries
// project knowledge.
// =============================================================================

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { runSetupWorktree, helpers } from "@paleo/worktree-env";

// ALTERNATIVE: file-based DB (SQLite). Replace the Docker block in
// `setupWorktreeData` and the `docker-compose.yml` configFile entry with a
// copy from the main worktree:
//
//   import { cpSync, existsSync, readdirSync } from "node:fs";
//   import { join } from "node:path";
//   setupWorktreeData: ({ currentWorktree, mainWorktree, force }) => {
//     const localData = join(currentWorktree, ".local-data/data");
//     const mainData = join(mainWorktree, ".local-data/data");
//     mkdirSync(localData, { recursive: true });
//     if (readdirSync(localData).length > 0 && !force) return;
//     if (!existsSync(mainData)) return;
//     cpSync(mainData, localData, { recursive: true, force: true });
//   },
//   teardownInfrastructure: undefined,

await runSetupWorktree({
  // ADAPT: anchor port for the slot range. 8100 is the safe default.
  basePort: 8100,

  // ADAPT: ports derived from the slot. Either provide `portNames` for the
  // simple `slot+i` mapping, or supply `ports(slot)` for full control.
  portNames: ["server", "frontend", "db"],
  // ports: (slot) => ({ server: slot, frontend: slot + 1, db: slot + 2 }),

  // ADAPT: PID files written by the dev-server (must match dev-server.mjs).
  devServerPidFiles: [".local-data/dev-server.pid"],

  // ADAPT: gitignored config files copied from the main worktree and patched
  // per slot. The source is the same path in the main worktree.
  configFiles: [
    {
      path: ".env",
      patch: (content, { ports }) => {
        // Use extractHost to preserve a non-localhost API_URL configured in the
        // main worktree (e.g. a public dev-server IP).
        const apiHost = helpers.extractHost(content, "API_URL");
        return helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          SERVER_PORT: String(ports.server),
          API_URL: `http://${apiHost}:${ports.server}`,
        });
      },
    },
    // ADAPT: Docker example. Patches the host port and the container_name so
    // worktrees don't collide. Drop this entry on a non-Docker stack.
    {
      path: "docker-compose.yml",
      patch: (content, { slot, ports, mainWorktree }) => {
        const repoName = basename(mainWorktree);
        return content
          .replace(/^(\s*-\s*")[^"]*:5432(")/m, `$1${ports.db}:5432$2`)
          .replace(/^(\s*container_name:\s*).+$/m, `$1${repoName}-database-slot-${slot}`);
      },
    },
  ],

  // ADAPT: per-worktree data setup. Runs after symlinks and config files.
  // Create any required directories first, then provision DB / file storage.
  setupWorktreeData: async ({ currentWorktree }) => {
    mkdirSync(join(currentWorktree, ".local-data"), { recursive: true });
    execSync("docker compose up -d", { stdio: "inherit", cwd: currentWorktree });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        execSync("docker compose exec database pg_isready", {
          stdio: "pipe",
          cwd: currentWorktree,
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("Database did not become ready within 30s.");
  },

  // ADAPT: Docker teardown. Called by --remove. Drop on a non-Docker stack.
  teardownInfrastructure: ({ worktree }) => {
    try {
      execSync("docker compose down -v", { stdio: "pipe", cwd: worktree });
    } catch {
      // container may not exist
    }
  },

  // ADAPT
  installAndBuild: ({ currentWorktree }) => {
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
    execSync("npm run build", { stdio: "inherit", cwd: currentWorktree });
  },

  // ADAPT
  afterDatabase: ({ currentWorktree }) => {
    execSync("npm run migrate", { stdio: "inherit", cwd: currentWorktree });
    execSync("npm run seed", { stdio: "inherit", cwd: currentWorktree });
  },

  // ADAPT
  printSummary: ({ slot, branch, owner, ports }) => `
Worktree setup complete!
  Slot:     ${slot}
  Branch:   ${branch}${owner ? `\n  Owner:    ${owner}` : ""}
  Server:   http://localhost:${ports.server}/
  Frontend: http://localhost:${ports.frontend}/
  DB port:  ${ports.db}
`,
});
