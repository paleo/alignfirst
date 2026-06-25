// =============================================================================
// Reference: workspace.mjs
//
// Thin wrapper around `@paleo/workspace`. Search for "ADAPT" to find every
// project-specific field. The kernel (slot registry, port math, branch
// lifecycle, removal flow, CLI) lives in the package; this file only carries
// project knowledge.
// =============================================================================

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspace, helpers } from "@paleo/workspace";

// ALTERNATIVE: file-based DB (SQLite). Replace the Docker block in
// `finalizeWorktree` and the `docker-compose.yml` configFile entry with a
// copy from the main worktree:
//
//   import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
//   import { join } from "node:path";
//   // inside finalizeWorktree, before install/build:
//   const localData = join(currentWorktree, ".local-wt/data");
//   const mainData = join(mainWorktree, ".local-wt/data");
//   mkdirSync(localData, { recursive: true });
//   if (readdirSync(localData).length === 0 && existsSync(mainData)) {
//     cpSync(mainData, localData, { recursive: true, force: true });
//   }

await runWorkspace({
  // Required. The package re-spawns this script for the detached finalize phase, so it must know
  // where it lives. Leave this line as-is — `import.meta.url` always resolves to this file.
  scriptPath: fileURLToPath(import.meta.url),

  // Required. Absolute path to your dev-server script. On `workspace remove`, the
  // kernel shells out to `node <devServerScript> down` with cwd set to the
  // target worktree. Leave this line as-is.
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),

  // ADAPT: anchor port for the slot range. 8100 is the safe default.
  basePort: 8100,

  // ADAPT: ports derived from the slot. Either provide `portNames` for the
  // simple `slot+i` mapping, or supply `ports(slot)` for full control.
  portNames: ["server", "frontend", "db"],
  // ports: (slot) => ({ server: slot, frontend: slot + 1, db: slot + 2 }),

  // ADAPT: directories symlinked from the main worktree.
  sharedDirs: [".local", ".plans"],

  // Per-worktree runtime directory. The package writes the setup log
  // and dev-server logs under here.
  runtimeDir: ".local-wt",

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

  // ADAPT: Detached finalization step. Runs in the background after the
  // worktree is created and the foreground command has returned.
  //
  // MUST BE IDEMPOTENT — `workspace setup` is the documented retry
  // path. Guard each block against pre-existing state so re-runs are no-ops.
  //
  // Run `npm install` first: any later failure then leaves a worktree with
  // usable node_modules, so `workspace setup` can re-import @paleo/workspace.
  finalizeWorktree: async ({ currentWorktree, mainWorktree, slot, ports }) => {
    const container = `${basename(mainWorktree)}-database-slot-${slot}`;
    // A worktree previously at this slot, deleted out-of-band, may have leaked its container
    // (it belongs to a different compose project, so `up` can't reuse it — it errors on the name
    // conflict). Force-remove it by name first so `up` is idempotent across slot reuse.
    try {
      execSync(`docker rm -f ${container}`, { stdio: "pipe" });
    } catch {
      // no leftover container
    }
    // `npm install` and `npm run build` are idempotent.
    execSync("npm install", { stdio: "inherit", cwd: currentWorktree });
    execSync("npm run build", { stdio: "inherit", cwd: currentWorktree });
    // `docker compose up -d` is already idempotent.
    execSync("docker compose up -d", { stdio: "inherit", cwd: currentWorktree });
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        // Force a TCP check (-h 127.0.0.1). On a fresh volume, Postgres first runs a
        // throwaway Unix-socket-only server for initdb that answers a plain pg_isready,
        // then restarts the real server. A socket-side probe passes too early, so the
        // next step connects to that init server and loses the connection on handoff.
        execSync("docker compose exec -T database pg_isready -h 127.0.0.1 -q", {
          stdio: "pipe",
          cwd: currentWorktree,
        });
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!ready) throw new Error("Database did not become ready within 30s.");
    // Migrations are idempotent; seeds typically guard on existing rows.
    execSync("npm run migrate", { stdio: "inherit", cwd: currentWorktree });
    execSync("npm run seed", { stdio: "inherit", cwd: currentWorktree });
    // Returning is OPTIONAL — omit the two lines below entirely if you have
    // nothing to record (the common case). Return `{ extra }` ONLY for teardown
    // identifiers you can't re-derive at purge time: container/volume names are
    // derived from slot + paths (see purgeInfrastructure), so they don't go here,
    // but a non-derivable external resource does — e.g. a public dev tunnel
    // opened now, whose provider hands back an opaque id.
    const tunnelId = openDevTunnel(ports.frontend); // ADAPT: your external resource
    return { extra: { tunnelId } };
  },

  // ADAPT: destructive infrastructure teardown — typically `docker compose
  // down -v` to wipe volumes. Runs on `workspace remove`, `workspace prune`,
  // and orphan removal. Drop on a non-Docker stack.
  //
  // MUST BE IDEMPOTENT — tolerate already-absent infrastructure. May run when
  // `worktree` is gone (orphan); the container/volume names are derived from
  // slot + paths, so teardown works without the worktree. `extra` carries only
  // the non-derivable bits (here, the external tunnel id).
  purgeInfrastructure: ({ worktree, mainWorktree, slot, extra }) => {
    const container = `${basename(mainWorktree)}-database-slot-${slot}`;
    const project = basename(worktree);
    try {
      if (existsSync(worktree)) {
        execSync("docker compose down -v", { stdio: "pipe", cwd: worktree });
      } else {
        execSync(`docker rm -f ${container}`, { stdio: "pipe" });
        execSync(`docker volume rm ${project}_db-data`, { stdio: "pipe" });
      }
      if (extra?.tunnelId) closeDevTunnel(extra.tunnelId); // ADAPT: external teardown
    } catch {
      // infra may already be gone
    }
  },

  // ADAPT. Do not list dev-server URLs here — the dev-server is not running yet
  // at this point. The worktree path is the useful pointer.
  printSummary: ({ slot, branch, owner, currentWorktree, isMainWorktree }) => `
Workspace setup complete!
  Worktree type: ${isMainWorktree ? "main" : "linked"}
  Slot:          ${slot}
  Branch:        ${branch}${owner ? `\n  Owner:         ${owner}` : ""}
  Path:          ${currentWorktree}
`,
});
