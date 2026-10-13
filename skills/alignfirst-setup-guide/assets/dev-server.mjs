// =============================================================================
// Reference: dev-server.mjs
//
// Thin wrapper around `@alignfirst/workspace`. Search for "ADAPT" to find every
// project-specific field. This file owns the run side of a workspace: its
// ports, the files that carry them (`runFiles`) and its infrastructure
// (`setup`). `dev setup` brings them, explicitly or before every start.
//
// Two-tier shutdown: `dev down` kills dev processes and runs callback stop()
// (e.g. `docker compose down`); `workspace remove` re-execs this script's
// `down` in the target worktree and then runs `purgeInfrastructure`
// (workspace.mjs) to drop volumes.
//
// NOTE: this wrapper is wired to the `dev` npm script, so a spawn server must
// not run `npm run dev` — that would recurse. Use a distinct script name
// (e.g. `dev:app`) for the app's own dev command.
// =============================================================================

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { helpers, runDevServer } from "@alignfirst/workspace";

await runDevServer({
  runtimeDir: ".local-wt", // Per-worktree runtime directory. The symlinked registry lives at `${runtimeDir}/workspace-registry`.
  maxConcurrentDevServers: 5,    // ADAPT — cap on concurrent dev-servers across worktrees; omit for no limit.

  // ADAPT (optional): the project's port range. Each workspace gets one port
  // per name at its first `dev setup`, the lowest free one, and keeps it. Omit
  // the group for a portless dev-server: `ctx.ports` is then empty everywhere.
  ports: {
    // ADAPT: size the range as names × expected concurrent workspaces. Must
    // equal `portRange` in `.alignfirst.json` when that file exists.
    first: 8100,
    last: 8199,
    // ADAPT (optional): ports never allocated, single or inclusive ranges.
    // exclude: [8125, { first: 8180, last: 8189 }],
    names: ["server", "frontend", "db"],
    // ADAPT (optional): fixed ports for the main worktree, when something
    // outside the repository depends on them (a bookmark, an OAuth callback URL).
    // mainWorktree: { server: 8100, frontend: 8101 },
  },

  // ADAPT: the gitignored files that carry ports, or are needed only to run.
  // A file carrying ports is a run file: it belongs here, not in
  // `gitignoredFiles` (workspace.mjs). `dev setup` writes them before every
  // start: a missing file is created from its `source`, an existing one is
  // re-patched. Sources and `patch` work as in `gitignoredFiles`; the context
  // adds `ports`.
  runFiles: [
    {
      path: ".env",
      source: { kind: "mainWorktree", fallback: ".env.example" },
      patch: (content, { ports }) =>
        helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          SERVER_PORT: String(ports.server),
          // ADAPT: every URL a browser or a third party resolves (API base
          // URL, front URL, OAuth callbacks, CORS origins, allowed hosts).
          // Server-to-server URLs stay on localhost.
          API_URL: publicUrl(ports.server),
          // ADAPT: Docker example, a committed docker-compose.yml publishing
          // "127.0.0.1:${DB_PORT:?run dev setup}:5432". Compose reads this .env
          // on its own. Drop the line on a non-Docker stack.
          DB_PORT: String(ports.db),
        }),
    },
    // ALTERNATIVE: a gitignored docker-compose.yml seeded from a committed
    // example. Follow the pattern the repo already uses. Patch the host port, and
    // the container_name when the file declares one:
    //
    //   {
    //     path: "docker-compose.yml",
    //     source: { kind: "mainWorktree", fallback: "docker-compose.example.yml" },
    //     patch: (content, { name, ports }) =>
    //       content
    //         .replace(/^(\s*-\s*")[^"]*:5432(")/m, `$1${ports.db}:5432$2`)
    //         .replace(/^(\s*container_name:\s*).+$/m, `$1${name}-database`),
    //   },
    //
    // A container_name is global: a leftover container of that name makes `up`
    // fail on the conflict. Force-remove it first in `setup`:
    //
    //   try {
    //     execFileSync("docker", ["rm", "-f", `${name}-database`], { stdio: "pipe" });
    //   } catch {
    //     // no leftover container
    //   }
  ],

  // ADAPT: the workspace's infrastructure. Runs at its first `dev setup`, and
  // again with `dev setup --force`. MUST BE IDEMPOTENT. Name every resource
  // after the workspace (`name`): `purgeInfrastructure` (workspace.mjs) tears
  // it down by name. Drop it on a stack without infrastructure.
  setup: async ({ name, currentWorktree, mainWorktree, ports }) => {
    // `docker compose up -d` is already idempotent. A reused workspace name maps to
    // the same compose project, so `up` takes over a container leaked by an orphan.
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

    // ADAPT: an external resource, here a public dev tunnel, opened under a
    // name derived from the workspace. This provider returns only a random id,
    // so record it in a file named after the workspace as soon as the tunnel
    // exists. Build the path from `mainWorktree`: a linked worktree's own
    // `.local-wt` goes away with it. `purgeInfrastructure` reads the same path.
    const tunnelId = openDevTunnel({ name: `${name}-dev`, port: ports.frontend });
    const tunnelFile = join(mainWorktree, ".local-wt", "tunnels", name);
    mkdirSync(dirname(tunnelFile), { recursive: true });
    writeFileSync(tunnelFile, tunnelId);

    // ALTERNATIVE: file-based DB (SQLite). Replace the Docker block above, and
    // the `DB_PORT` line of the `.env` patch, with a copy from the main worktree:
    //
    //   import { cpSync, existsSync, readdirSync } from "node:fs";
    //   const localData = join(currentWorktree, ".local-wt/data");
    //   const mainData = join(mainWorktree, ".local-wt/data");
    //   mkdirSync(localData, { recursive: true });
    //   if (readdirSync(localData).length === 0 && existsSync(mainData)) {
    //     cpSync(mainData, localData, { recursive: true, force: true });
    //   }
  },

  servers: [
    // ADAPT: uncomment to start Docker with the dev server and stop it with
    // `dev down`. `docker compose up -d` also recreates a container whose
    // published port moved.
    // {
    //   kind: "callback",
    //   name: "docker",
    //   start: async ({ cwd }) => {
    //     // `inherit` so docker's output/error is visible; a failure throws and aborts the start.
    //     execSync("docker compose up -d", { stdio: "inherit", cwd });
    //     const deadline = Date.now() + 30_000;
    //     while (Date.now() < deadline) {
    //       try {
    //         execSync("docker compose exec -T database pg_isready -h 127.0.0.1 -q", { stdio: "pipe", cwd });
    //         return;
    //       } catch {
    //         await new Promise((r) => setTimeout(r, 1000));
    //       }
    //     }
    //     throw new Error("PostgreSQL did not become ready within 30s.");
    //   },
    //   stop: async ({ cwd }) => {
    //     execSync("docker compose down", { stdio: "inherit", cwd });
    //   },
    // },
    {
      kind: "spawn",                                        // ADAPT
      name: "dev",                                          // ADAPT
      exec: { command: "npm", args: ["run", "dev:app"] },   // ADAPT — must not be `dev` (recurses into this wrapper)
      // ADAPT: a name from `ports.names`, resolved to the workspace's port.
      // Optional: omit `port` for a process that listens on nothing; port-conflict
      // checks, port sweeping and the summary URL then skip this server.
      port: "frontend",
      detectReady: (log) => log.includes("Server is ready on port"), // ADAPT
      // ADAPT: return the matched label, or false. Example with fatal markers:
      //   detectError: (log) => ["[ExceptionHandler]", "Node.js v"].find((m) => log.includes(m)) ?? false,
    },
    // ALTERNATIVE: two-process dev server (API watcher + frontend bundler).
    // {
    //   kind: "spawn",
    //   name: "api",
    //   exec: { command: "npm", args: ["run", "watch:api"] },
    //   port: "server",
    //   detectReady: (log) => log.includes("API listening on"),
    //   detectError: (log) => log.includes("Node.js v") ? "Node.js v" : false,
    // },
    // {
    //   kind: "spawn",
    //   name: "front",
    //   exec: { command: "npm", args: ["run", "watch:front"] },
    //   port: "frontend",
    //   detectReady: (log) => log.includes("ready in"),
    // },
  ],

  // ADAPT (managed project): report the public URL instead of the default
  // `http://localhost:<port>/`. Read it from `.env`, where the run-file patch
  // wrote it.
  //
  // ADAPT (callback servers): a callback server has no port, no PID and no log
  // file, so this is the only place it can surface. Give it a row of the same
  // shape as the spawn servers — what it is reached by, then how its logs are
  // read — so one column means one thing on every row. For a database: the
  // connection string without the password, the container name (compose's
  // `<project>-<service>-1`, or the seeded `container_name`), and the command
  // that tails the container logs.
  //
  // Needs `import { readFileSync } from "node:fs";`.
  // formatSummary: ({ workspace, servers }) => {
  //   const env = readFileSync(".env", "utf8");
  //   const read = (name) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  //   const rows = servers
  //     .filter(({ pid }) => pid !== undefined) // Callback servers have none.
  //     .map(({ server, pid }) => `  ${server.name}: PID ${pid}  log: .local-wt/logs/${server.name}.log`);
  //   const db = `${read("DB_USER")}@127.0.0.1:${read("DB_PORT")}/${read("DB_NAME")}`;
  //   const container = `${helpers.composeProjectName(workspace.name)}-database-1`;
  //   return [
  //     `Dev server up for ${workspace.name}: ${read("API_URL")}`,
  //     ...rows,
  //     `  database: ${db}  (${container})  log: docker compose logs -f database`,
  //   ].join("\n");
  // },
});

// ADAPT (managed project): the URL a browser reaches `port` at, computed at
// each `dev setup` from the environment. REMOTE_DEV_DOMAIN: the HTTPS gateway
// serves each port at `p<port>.<domain>`. REMOTE_DEV_HOST: the browser reaches
// the machine directly, so the servers must listen on every interface.
function publicUrl(port) {
  const domain = process.env.REMOTE_DEV_DOMAIN;
  if (domain !== undefined && domain !== "") return `https://p${port}.${domain}`;
  const host = process.env.REMOTE_DEV_HOST;
  if (host !== undefined && host !== "") return `http://${host}:${port}`;
  return `http://localhost:${port}`;
}
