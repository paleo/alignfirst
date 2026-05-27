// =============================================================================
// Reference: dev-server.mjs
//
// Thin wrapper around `@paleo/workspace`. Search for "ADAPT" to find every
// project-specific field. Two-tier shutdown: --stop kills dev processes and
// runs callback stop() (e.g. `docker compose down`); `workspace remove`
// re-execs this script's --stop in the target worktree and then runs
// `purgeInfrastructure` to drop volumes.
// =============================================================================

import { runDevServer, helpers } from "@paleo/workspace";

await runDevServer({
  basePort: 8100, // ADAPT
  runtimeDir: ".local-wt", // Per-worktree runtime directory; dev-server log paths derive from this + each server's name.
  registryDir: ".local/wt-registry", // Shared registry dir (`slots.json`, `dev-servers.json`); reached via the `.local` symlink in linked worktrees.
  devLimit: 5,    // ADAPT — cap on concurrent dev-servers across worktrees; omit for no limit.

  servers: [
    // ADAPT: uncomment to manage Docker / a database alongside the dev server.
    // {
    //   kind: "callback",
    //   name: "docker",
    //   start: async ({ cwd }) => {
    //     execSync("docker compose up -d", { stdio: "pipe", cwd });
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
    //     execSync("docker compose down", { stdio: "pipe", cwd });
    //   },
    // },
    {
      kind: "spawn",                                        // ADAPT
      name: "dev",                                          // ADAPT
      exec: { command: "npm", args: ["run", "dev"] },       // ADAPT
      port: helpers.readPortFromEnvFile(".env", "PORT"),    // ADAPT — or helpers.readPortFromJsonFile("config.json", "server.port")
      detectSuccess: (log) => log.includes("Server is ready on port"), // ADAPT
      // ADAPT: return the matched label, or false. Example with fatal markers:
      //   detectError: (log) => ["[ExceptionHandler]", "Node.js v"].find((m) => log.includes(m)) ?? false,
    },
    // ALTERNATIVE: two-process dev server (API watcher + frontend bundler).
    // {
    //   kind: "spawn",
    //   name: "api",
    //   exec: { command: "npm", args: ["run", "watch:api"] },
    //   port: helpers.readPortFromEnvFile(".env", "SERVER_PORT"),
    //   detectSuccess: (log) => log.includes("API listening on"),
    //   detectError: (log) => log.includes("Node.js v") ? "Node.js v" : false,
    // },
    // {
    //   kind: "spawn",
    //   name: "front",
    //   exec: { command: "npm", args: ["run", "watch:front"] },
    //   port: helpers.readPortFromEnvFile(".env", "PORT"),
    //   detectSuccess: (log) => log.includes("ready in"),
    // },
  ],
});
