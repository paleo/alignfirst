// =============================================================================
// Reference: dev-server.mjs
//
// Thin wrapper around `@paleo/worktree-env`. Search for "ADAPT" to find every
// project-specific field. Two-tier shutdown: --stop kills dev processes only;
// infrastructure teardown lives in setup-worktree --remove.
// =============================================================================

import { runDevServer, helpers } from "@paleo/worktree-env";

await runDevServer({
  basePort: 8100, // ADAPT
  runtimeDir: ".local-wt", // Per-worktree runtime directory; pid/log paths derive from this + each server's name.
  registryDir: ".local/wt-registry", // Shared registry dir (`slots.json`, `dev-servers.json`); reached via the `.local` symlink in linked worktrees.
  devLimit: 5,    // ADAPT — cap on concurrent dev-servers across worktrees; omit for no limit.

  servers: [
    {
      name: "dev",                                          // ADAPT
      exec: { command: "npm", args: ["run", "dev"] },       // ADAPT
      port: helpers.readPortFromEnvFile(".env", "PORT"),    // ADAPT — or helpers.readPortFromJsonFile("config.json", "server.port")
      detectSuccess: (log) => log.includes("Server is ready on port"), // ADAPT
      // ADAPT: return the matched label, or false. Example with fatal markers:
      //   detectError: (log) => ["[ExceptionHandler]", "Node.js v"].find((m) => log.includes(m)) ?? false,
    },
    // ALTERNATIVE: two-process dev server (API watcher + frontend bundler).
    // {
    //   name: "api",
    //   exec: { command: "npm", args: ["run", "watch:api"] },
    //   port: helpers.readPortFromEnvFile(".env", "SERVER_PORT"),
    //   detectSuccess: (log) => log.includes("API listening on"),
    //   detectError: (log) => log.includes("Node.js v") ? "Node.js v" : false,
    // },
    // {
    //   name: "front",
    //   exec: { command: "npm", args: ["run", "watch:front"] },
    //   port: helpers.readPortFromEnvFile(".env", "PORT"),
    //   detectSuccess: (log) => log.includes("ready in"),
    // },
  ],

  // ADAPT: uncomment to start Docker / databases before the dev server.
  // ensureInfrastructure: () => {
  //   execSync("docker compose up -d", { stdio: "pipe" });
  // },
});
