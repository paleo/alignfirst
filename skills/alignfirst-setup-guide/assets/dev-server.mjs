// =============================================================================
// Reference: dev-server.mjs
//
// Thin wrapper around `@alignfirst/workspace`. Search for "ADAPT" to find every
// project-specific field. Two-tier shutdown: `dev down` kills dev processes and
// runs callback stop() (e.g. `docker compose down`); `workspace remove`
// re-execs this script's `down` in the target worktree and then runs
// `purgeInfrastructure` to drop volumes.
//
// NOTE: this wrapper is wired to the `dev` npm script, so a spawn server must
// not run `npm run dev` — that would recurse. Use a distinct script name
// (e.g. `dev:app`) for the app's own dev command.
// =============================================================================

import { helpers, runDevServer } from "@alignfirst/workspace";

await runDevServer({
  runtimeDir: ".local-wt", // Per-worktree runtime directory. The symlinked registry lives at `${runtimeDir}/workspace-registry`.
  maxConcurrentDevServers: 5,    // ADAPT — cap on concurrent dev-servers across worktrees; omit for no limit.

  servers: [
    // ADAPT: uncomment to manage Docker / a database alongside the dev server.
    // {
    //   kind: "callback",
    //   name: "docker",
    //   start: async ({ cwd }) => {
    //     // `inherit` so docker's output/error is visible; a failure throws and aborts the start.
    //     execSync("docker compose up -d", { stdio: "inherit", cwd });
    //     const deadline = Date.now() + 30_000;
    //     while (Date.now() < deadline) {
    //       try {
    //         execSync("docker compose exec database pg_isready", { stdio: "pipe", cwd });
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
      // ADAPT — or helpers.readPortFromJsonFile("config.json", "server.port").
      // Optional: omit `port` for a process that listens on nothing; port-conflict
      // checks, port sweeping and the summary URL then skip this server.
      port: helpers.readPortFromEnvFile(".env", "PORT"),
      detectReady: (log) => log.includes("Server is ready on port"), // ADAPT
      // ADAPT: return the matched label, or false. Example with fatal markers:
      //   detectError: (log) => ["[ExceptionHandler]", "Node.js v"].find((m) => log.includes(m)) ?? false,
    },
    // ALTERNATIVE: two-process dev server (API watcher + frontend bundler).
    // {
    //   kind: "spawn",
    //   name: "api",
    //   exec: { command: "npm", args: ["run", "watch:api"] },
    //   port: helpers.readPortFromEnvFile(".env", "SERVER_PORT"),
    //   detectReady: (log) => log.includes("API listening on"),
    //   detectError: (log) => log.includes("Node.js v") ? "Node.js v" : false,
    // },
    // {
    //   kind: "spawn",
    //   name: "front",
    //   exec: { command: "npm", args: ["run", "watch:front"] },
    //   port: helpers.readPortFromEnvFile(".env", "PORT"),
    //   detectReady: (log) => log.includes("ready in"),
    // },
  ],

  // ADAPT (managed project): report the public URL instead of the default
  // `http://localhost:<port>/`, read from the file the `remote` profile rewrites
  // (see workspace.mjs). Both profile variants write it to the same variable.
  //
  // ADAPT (callback servers): a callback server has no port, no PID and no log
  // file, so this is the only place it can surface. Give it a row of the same
  // shape as the spawn servers — what it is reached by, then how its logs are
  // read — so one column means one thing on every row. For a database: the
  // connection string without the password, the workspace-scoped container name,
  // and the command that tails the container logs.
  //
  // Needs `import { readFileSync } from "node:fs";`.
  // formatSummary: ({ workspace, servers }) => {
  //   const env = readFileSync(".env", "utf8");
  //   const read = (name) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  //   const rows = servers
  //     .filter(({ pid }) => pid !== undefined) // Callback servers have none.
  //     .map(({ server, pid }) => `  ${server.name}: PID ${pid}  log: .local-wt/logs/${server.name}.log`);
  //   const db = `${read("DB_USER")}@127.0.0.1:${read("DB_PORT")}/${read("DB_NAME")}`;
  //   return [
  //     `Dev server up for ${workspace.name}: ${read("API_URL")}`,
  //     ...rows,
  //     `  database: ${db}  (${workspace.name}-database)  log: docker compose logs -f database`,
  //   ].join("\n");
  // },
});
