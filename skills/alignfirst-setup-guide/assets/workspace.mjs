// =============================================================================
// Reference: workspace.mjs
//
// Thin wrapper around `@paleo/workspace`. Search for "ADAPT" to find every
// project-specific field. The kernel (workspace registry, port allocation,
// branch lifecycle, removal flow, CLI) lives in the package; this file only
// carries project knowledge.
// =============================================================================

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspace, helpers } from "@paleo/workspace";

// ALTERNATIVE: file-based DB (SQLite). Replace the Docker block in
// `finalizeWorkspace` and the `docker-compose.yml` gitignoredFiles entry with a
// copy from the main worktree:
//
//   import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
//   import { join } from "node:path";
//   // inside finalizeWorkspace, before install/build:
//   const localData = join(currentWorktree, ".local-wt/data");
//   const mainData = join(mainWorktree, ".local-wt/data");
//   mkdirSync(localData, { recursive: true });
//   if (readdirSync(localData).length === 0 && existsSync(mainData)) {
//     cpSync(mainData, localData, { recursive: true, force: true });
//   }

await runWorkspace({
  // Required. The package re-spawns this script for the detached finalize phase, so it must know
  // where it lives. Leave this line as-is — `import.meta.url` always resolves to this file.
  workspaceScript: fileURLToPath(import.meta.url),

  // ADAPT (optional): absolute path to your dev-server script. On `workspace
  // remove`, the kernel shells out to `node <devServerScript> down` with cwd set
  // to the target worktree. Drop this field — and `dev-server.mjs` itself — in a
  // setup-only project.
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),

  // ADAPT (optional): the port scheme. Each workspace gets a contiguous block of
  // `perWorkspace` ports; the main worktree's block starts at `base`.
  // Omit the whole group for a portless project: nothing is allocated, and
  // `ctx.ports` is empty everywhere.
  ports: {
    // ADAPT: first port of the main worktree's block. 8100 is the safe default.
    base: 8100,

    // ADAPT: maximum workspaces, main worktree included. The scheme spans
    // `maxWorkspaces * perWorkspace` ports from `base`.
    maxWorkspaces: 20,

    // ADAPT (optional): block size and spacing, so also the maximum ports per
    // workspace. Defaults to `names.length` (required with `compute`); set it
    // explicitly to reserve headroom, since adding a name later shifts every
    // workspace's block under the default.
    // perWorkspace: 10,

    // ADAPT: exactly one of `names` (consecutive ports from the block's first
    // port) or `compute` (full control over the block).
    names: ["server", "frontend", "db"],
    // compute: ({ index, firstPort }) => ({
    //   server: firstPort,
    //   frontend: firstPort + 1,
    //   db: firstPort + 2,
    // }),
  },

  // ADAPT: directories symlinked from the main worktree.
  sharedDirs: [".local", ".plans"],

  // Per-worktree runtime directory. The package writes the setup log
  // and dev-server logs under here.
  runtimeDir: ".local-wt",

  // ADAPT: EVERY gitignored file a linked worktree needs — not only the
  // port-bearing ones. Each entry declares a `source`:
  //   { kind: "mainWorktree", fallback } copy the main-worktree file when it exists,
  //                                       otherwise a committed fallback from this branch
  //   { kind: "committed", path: "..." }  copy a committed template (e.g. an
  //                                       .example) from the worktree's checkout
  //   { kind: "content", content }        inline string, or a sync/async function
  //                                       receiving the same context as `patch`
  // `patch` is optional — omit it to copy verbatim (see ".vscode/settings.json").
  // Omitting an entry leaves the linked worktree silently missing that file.
  gitignoredFiles: [
    {
      path: ".env",
      source: { kind: "mainWorktree", fallback: ".env.example" },
      // `publicUrl` (below) keeps the host configured in the main worktree — a
      // public IP, or the `p<port>.<domain>` written by the `remote` profile.
      patch: (content, { ports }) =>
        helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          SERVER_PORT: String(ports.server),
          API_URL: publicUrl(content, "API_URL", ports.server),
        }),
    },
    // ADAPT: Docker example. Patches the host port and the container_name so
    // worktrees don't collide. Drop this entry on a non-Docker stack.
    {
      path: "docker-compose.yml",
      source: { kind: "mainWorktree", fallback: "docker-compose.example.yml" },
      patch: (content, { name, ports }) =>
        content
          .replace(/^(\s*-\s*")[^"]*:5432(")/m, `$1${ports.db}:5432$2`)
          .replace(/^(\s*container_name:\s*).+$/m, `$1${name}-database`),
    },
    // ADAPT: a verbatim copy — no ports, just a gitignored file the worktree
    // needs. No `patch`. `optional: true` skips it (with a warning) when absent.
    {
      path: ".vscode/settings.json",
      source: {
        kind: "mainWorktree",
        fallback: ".vscode/settings.example.json",
      },
      optional: true,
    },
  ],

  // ADAPT (dev server, managed project): the `remote` setup profile, required by
  // the AlignFirst Developer contract. This is the HTTPS-gateway variant:
  // `setup --profile remote` rewrites the main worktree's public URLs to
  // `https://p<port>.<domain>` with `<domain>` from REMOTE_DEV_DOMAIN; linked
  // worktrees inherit them through `publicUrl`. List every variable a browser or a
  // third party resolves (API base URL, front URL, OAuth callbacks, CORS origins,
  // allowed hosts); server-to-server URLs stay on localhost. The servers keep
  // listening on localhost. Drop both fields in a project without a dev server.
  preSetup: ({ profile }) => {
    if (profile === "remote" && !process.env.REMOTE_DEV_DOMAIN) {
      throw new Error("REMOTE_DEV_DOMAIN is not set.");
    }
  },
  setupProfiles: {
    remote: {
      description: "public URLs through the dev-server gateway (REMOTE_DEV_DOMAIN)",
      apply: ({ currentWorktree, ports }) => {
        const envFile = join(currentWorktree, ".env");
        const content = readFileSync(envFile, "utf8");
        const patched = helpers.patchEnvFile(content, {
          API_URL: `https://p${ports.server}.${process.env.REMOTE_DEV_DOMAIN}`,
        });
        if (patched !== content) writeFileSync(envFile, patched);
      },
    },
  },
  // ALTERNATIVE (public-IP variant, no gateway): the browser reaches
  // `http://<public-ip>:<port>` directly, so the servers must listen on every
  // interface. `apply` swaps the host of the same variables for the machine's
  // single public IPv4, keeping scheme and port; the `.env` patcher above keeps a
  // non-localhost host, so linked worktrees need nothing more. No `preSetup` check.
  //
  //   import { networkInterfaces } from "node:os";
  //   description: "public URLs on the machine's public IP instead of localhost",
  //   apply: ({ currentWorktree, ports }) => {
  //     const host = publicIPv4();
  //     const envFile = join(currentWorktree, ".env");
  //     const content = readFileSync(envFile, "utf8");
  //     const patched = helpers.patchEnvFile(content, {
  //       API_URL: `http://${host}:${ports.server}`,
  //     });
  //     if (patched !== content) writeFileSync(envFile, patched);
  //   },
  //   // The single public IPv4 on the interfaces (a VPS carries it). Loopback,
  //   // link-local, carrier-grade NAT and private ranges are skipped.
  //   function publicIPv4() {
  //     const found = Object.values(networkInterfaces())
  //       .flat()
  //       .filter((e) => e.family === "IPv4" && !e.internal && !isPrivateIPv4(e.address))
  //       .map((e) => e.address);
  //     if (found.length !== 1) {
  //       throw new Error(`Expected one public IPv4, found: ${found.join(", ") || "none"}.`);
  //     }
  //     return found[0];
  //   }
  //   function isPrivateIPv4(address) {
  //     const [a, b] = address.split(".").map(Number);
  //     if (a === 10 || a === 127) return true;
  //     if (a === 172 && b >= 16 && b <= 31) return true;
  //     if (a === 192 && b === 168) return true;
  //     if (a === 169 && b === 254) return true;
  //     return a === 100 && b >= 64 && b <= 127;
  //   }

  // ADAPT: Detached finalization step. Runs in the background after the
  // worktree is created and the foreground command has returned.
  //
  // MUST BE IDEMPOTENT — `workspace setup` is the documented retry
  // path. Guard each block against pre-existing state so re-runs are no-ops.
  //
  // Run `npm install` first: any later failure then leaves a worktree with
  // usable node_modules, so `workspace setup` can re-import @paleo/workspace.
  finalizeWorkspace: async ({ currentWorktree, name, ports }) => {
    const container = `${name}-database`;
    // A worktree of the same name, deleted out-of-band, may have leaked its container (it belongs
    // to a different compose project, so `up` can't reuse it — it errors on the name conflict).
    // Force-remove it by name first so `up` is idempotent when a name is reused.
    try {
      execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
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
    // nothing to record (the common case). Return `{ purgeData }` ONLY for teardown
    // identifiers you can't re-derive at purge time: container/volume names are
    // derived from the workspace name (see purgeInfrastructure), so they don't go
    // here, but a non-derivable external resource does — e.g. a public dev tunnel
    // opened now, whose provider hands back an opaque id.
    const tunnelId = openDevTunnel(ports.frontend); // ADAPT: your external resource
    return { purgeData: { tunnelId } };
  },

  // ADAPT: destructive infrastructure teardown — typically `docker compose
  // down -v` to wipe volumes. Runs on `workspace remove`, `workspace prune`,
  // and orphan removal. Drop on a non-Docker stack.
  //
  // MUST BE IDEMPOTENT — tolerate already-absent infrastructure. May run when
  // `worktree` is gone (orphan); the container/volume names are derived from the
  // workspace name, so teardown works without the worktree. `purgeData` carries only
  // the non-derivable bits (here, the external tunnel id).
  purgeInfrastructure: ({ worktree, name, purgeData }) => {
    try {
      if (existsSync(worktree)) {
        execSync("docker compose down -v", { stdio: "pipe", cwd: worktree });
      } else {
        execFileSync("docker", ["rm", "-f", `${name}-database`], { stdio: "pipe" });
        execFileSync("docker", ["volume", "rm", `${name}_db-data`], { stdio: "pipe" });
      }
      if (purgeData?.tunnelId) closeDevTunnel(purgeData.tunnelId); // ADAPT: external teardown
    } catch {
      // infra may already be gone
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

// Public URL of `key` on `port`. A `p<port>.<domain>` host (written by the
// `remote` profile) takes the port as its first label; any other host keeps
// `http://<host>:<port>`.
function publicUrl(content, key, port) {
  const host = helpers.extractHost(content, key);
  const remote = host.match(/^p\d+\.(.+)$/);
  return remote ? `https://p${port}.${remote[1]}` : `http://${host}:${port}`;
}
