# @paleo/worktree-env

Kernel for the worktree-based concurrent local-env system. Two entry points:

- `runSetupWorktree(config)` — worktree lifecycle (create / setup / remove / set-owner).
- `runDevServer(config)` — background dev-server start / stop / list.

Design rationale, port scheme, two-tier shutdown, and the slot/dev-server registry layout are documented in the [`worktree-env-guide skill`](../../skills/worktree-env-guide/SKILL.md). This README only covers the API surface.

## Usage

```ts
import { runSetupWorktree, helpers } from "@paleo/worktree-env";

await runSetupWorktree({
  basePort: 8100,
  portNames: ["server", "frontend", "db"],
  devLimitEnvVar: "MYAPP_DEV_LIMIT",
  devServerPidFiles: [".local-data/dev-server.pid"],
  configFiles: [
    {
      path: ".env",
      patch: (content, { ports }) =>
        helpers.patchEnvFile(content, {
          PORT: String(ports.frontend),
          SERVER_PORT: String(ports.server),
        }),
    },
  ],
  provisionDatabase: async () => {},
  installAndBuild: async () => {},
  printSummary: ({ slot, branch, owner, ports }) =>
    `Slot ${slot} (${branch}, ${owner}) — server :${ports.server}`,
});
```

```ts
import { runDevServer } from "@paleo/worktree-env";

await runDevServer({
  basePort: 8100,
  devLimitEnvVar: "MYAPP_DEV_LIMIT",
  servers: [
    {
      name: "dev",
      command: "npm",
      args: ["run", "dev"],
      pidFile: ".local-data/dev-server.pid",
      logFile: ".local-data/logs/dev-server.log",
      detectSuccess: (log) => log.includes("Server is ready on port"),
      portConfig: { file: ".env", var: "PORT" },
    },
  ],
  printSummary: ({ slot, owner, ports, pids }) =>
    `Dev servers started in slot ${slot} (${owner})`,
});
```

## Build / test

```sh
npm install
npm run build
npm test
```
