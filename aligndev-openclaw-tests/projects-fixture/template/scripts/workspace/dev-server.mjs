import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helpers, runDevServer } from "@alignfirst/workspace";

const appScript = fileURLToPath(new URL("../../app.mjs", import.meta.url));

await runDevServer({
  runtimeDir: ".local-wt",
  ports: {
    first: 6500,
    last: 6519,
    declare: ["frontend"],
  },
  runFiles: [
    {
      path: "local.env",
      source: { kind: "committed", path: "local.env.example" },
      patch: (content, { ports }) =>
        helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          PUBLIC_URL: publicUrl(ports.frontend),
        }),
    },
  ],
  runFilesInputs: () => ({
    REMOTE_DEV_DOMAIN: process.env.REMOTE_DEV_DOMAIN,
    REMOTE_DEV_HOST: process.env.REMOTE_DEV_HOST,
  }),
  servers: [
    {
      kind: "spawn",
      name: "app",
      exec: { command: "node", args: [appScript] },
      port: "frontend",
      detectReady: (log) => log.includes("listening on"),
    },
  ],
  formatSummary: ({ workspace, servers }) => {
    const appUrl = readFileSync(resolve(workspace.worktree, "local.env"), "utf8").match(
      /^PUBLIC_URL=(.+)$/m,
    )?.[1];
    if (appUrl === undefined || appUrl === "") {
      throw new Error("PUBLIC_URL is missing from local.env.");
    }
    const app = servers.find((s) => s.server.name === "app");
    return `
Dev servers started!
  Workspace: ${workspace.name}
  App:       ${appUrl}/  (PID ${app?.pid ?? ""})
`;
  },
});

function publicUrl(port) {
  const domain = process.env.REMOTE_DEV_DOMAIN;
  if (domain !== undefined && domain !== "") return `https://p${port}.${domain}`;
  const host = process.env.REMOTE_DEV_HOST;
  if (host !== undefined && host !== "") return `http://${host}:${port}`;
  return `http://localhost:${port}`;
}
