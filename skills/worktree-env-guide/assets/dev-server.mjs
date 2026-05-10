// =============================================================================
// Reference: dev-server.mjs
//
// Thin wrapper around `@paleo/worktree-env`. Search for "ADAPT" to find every
// project-specific field. Two-tier shutdown: --stop kills dev processes only;
// infrastructure teardown lives in setup-worktree --remove.
// =============================================================================

import { runDevServer } from "@paleo/worktree-env";

await runDevServer({
  basePort: 8100,                            // ADAPT
  devLimitEnvVar: "MYAPP_DEV_LIMIT",         // ADAPT

  servers: [
    {
      name: "dev",                                  // ADAPT
      command: "npm",                               // ADAPT
      args: ["run", "dev"],                         // ADAPT
      pidFile: ".local-data/dev-server.pid",        // ADAPT
      logFile: ".local-data/logs/dev-server.log",   // ADAPT
      detectSuccess: (log) => log.includes("Server is ready on port"),    // ADAPT
      // ADAPT: return the matched label, or false. Example with fatal markers:
      //   detectError: (log) => ["[ExceptionHandler]", "Node.js v"].find((m) => log.includes(m)) ?? false,
      portConfig: { file: ".env", var: "PORT" },    // ADAPT — or { file: "config.json", jsonPath: "server.port" }
    },
    // ALTERNATIVE: two-process dev server (API watcher + frontend bundler).
    // {
    //   name: "api",
    //   command: "npm",
    //   args: ["run", "watch:api"],
    //   pidFile: ".local-data/api.pid",
    //   logFile: ".local-data/logs/api.log",
    //   detectSuccess: (log) => log.includes("API listening on"),
    //   detectError: (log) => log.includes("Node.js v") ? "Node.js v" : false,
    //   portConfig: { file: ".env", var: "SERVER_PORT" },
    // },
    // {
    //   name: "front",
    //   command: "npm",
    //   args: ["run", "watch:front"],
    //   pidFile: ".local-data/front.pid",
    //   logFile: ".local-data/logs/front.log",
    //   detectSuccess: (log) => log.includes("ready in"),
    //   portConfig: { file: ".env", var: "PORT" },
    // },
  ],

  // ADAPT: uncomment to start Docker / databases before the dev server.
  // ensureInfrastructure: () => {
  //   execSync("docker compose up -d", { stdio: "pipe" });
  // },
});
