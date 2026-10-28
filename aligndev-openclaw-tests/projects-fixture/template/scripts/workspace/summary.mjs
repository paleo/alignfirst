import { readFileSync } from "node:fs";
import { join } from "node:path";

const { name, currentWorktree, servers } = JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT);
const url = readFileSync(join(currentWorktree, "local.env"), "utf8").match(
  /^PUBLIC_URL=(.+)$/m,
)?.[1];
if (url === undefined) throw new Error("PUBLIC_URL is missing from local.env.");
const app = servers.find((server) => server.name === "app");
process.stdout.write(
  `Dev servers started!\n  Workspace: ${name}\n  App: ${url}/  (PID ${app.pid})\n`,
);
