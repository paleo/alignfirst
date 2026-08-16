// Background dev-server wrapper. Single Express app; no docker, no API split.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { helpers, runDevServer } from "@paleo/workspace";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const appScript = resolve(root, "app.mjs");
// This worktree's port, written into `local.env` by `workspace setup`. The app
// reads the same file, so both sides agree.
const appPort = helpers.readPortFromEnvFile(resolve(root, "local.env"), "PORT");

await runDevServer({
  runtimeDir: ".local-wt",

  servers: [
    {
      kind: "spawn",
      name: "app",
      exec: { command: "node", args: [appScript] },
      port: appPort,
      detectReady: (log) => log.includes("listening on"),
    },
  ],

  formatSummary: ({ workspace, servers }) => {
    const app = servers.find((s) => s.server.name === "app");
    const pid = app?.pid ?? "";
    return `
Dev servers started!
  Workspace: ${workspace.name}
  App:       http://localhost:${app?.port ?? ""}/  (PID ${pid})
`;
  },
});
