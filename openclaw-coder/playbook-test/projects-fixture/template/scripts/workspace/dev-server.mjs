// Background dev-server wrapper. Single Express app; no docker, no API split.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { helpers, runDevServer } from "@paleo/workspace";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const appScript = resolve(root, "app.mjs");
// This worktree's slot port, written into `local.env` by `workspace setup`.
// The app reads the same file, so both sides agree.
const appPort = helpers.readPortFromEnvFile(resolve(root, "local.env"), "PORT");

await runDevServer({
  basePort: 6500,
  runtimeDir: ".local-wt",

  servers: [
    {
      kind: "spawn",
      name: "app",
      exec: { command: "node", args: [appScript] },
      port: appPort,
      detectSuccess: (log) => log.includes("listening on"),
    },
  ],

  printSummary: ({ slot, servers }) => {
    const app = servers.find((s) => s.server.name === "app");
    const pid = app?.pid ?? "";
    return `
Dev servers started!
  Slot:     ${slot.slot}
  App:      http://localhost:${app?.port ?? ""}/  (PID ${pid})
`;
  },
});
