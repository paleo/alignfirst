// Background dev-server wrapper. Single Express app; no docker, no API split.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runDevServer } from "@paleo/workspace";

const here = dirname(fileURLToPath(import.meta.url));
const appScript = resolve(here, "..", "..", "app.mjs");

await runDevServer({
  basePort: 6500,
  runtimeDir: ".local-wt",
  registryDir: ".local/_workspace-registry",

  servers: [
    {
      kind: "spawn",
      name: "app",
      exec: { command: "node", args: [appScript] },
      port: 6500,
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
