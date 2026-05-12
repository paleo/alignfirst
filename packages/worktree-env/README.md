# @paleo/worktree-env

Run multiple local dev environments side by side, one per git worktree, with isolated ports, databases, and config files. Built for branches worked in parallel, by humans or AI agents.

Each project writes two custom scripts on top, using these entry points:

- `runSetupWorktree(config)` — worktree lifecycle (create / setup / remove / set-owner).
- `runDevServer(config)` — background dev-server start / stop / list.

## Setup

The `worktree-env-guide` skill is a setup-time companion. Install the skill (globally or locally):

```bash
npx skills add https://github.com/paleo/alignfirst --skill worktree-env-guide
```

Then, in your project, ask your agent:

```text
Use your worktree-env-guide skill. Set up worktree-based local environments in this project.
```

The agent reads the skill, adapts the reference scripts to your stack, installs `@paleo/worktree-env` as a dev dependency, and wires the npm scripts. After that, you can uninstall the skill, it won't be used by your project anymore.

## Workflow

```sh
npm run setup-worktree -- --create feat/42   # new branch + worktree + isolated env
npm run dev:up                               # start dev server in the background
npm run dev:list                             # active dev-servers across all worktrees
npm run dev:down                             # stop dev server (infrastructure stays up)
npm run setup-worktree -- --remove feat/42   # full teardown
```

## API

```ts
import { runSetupWorktree, helpers } from "@paleo/worktree-env";

await runSetupWorktree({
  basePort: 8100,
  portNames: ["server", "frontend", "db"],
  devServerPidFiles: [".local-wt/dev-server.pid"],
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
  setupWorktreeData: async ({ currentWorktree }) => {
    // Create per-worktree directories, copy seed data, start containers, etc.
  },
  installAndBuild: async () => {},
  printSummary: ({ slot, branch, owner, ports }) =>
    `Slot ${slot} (${branch}${owner ? `, ${owner}` : ""}) — server :${ports.server}`,
});
```

```ts
import { runDevServer, helpers } from "@paleo/worktree-env";

await runDevServer({
  basePort: 8100,
  devLimit: 5,
  servers: [
    {
      name: "dev",
      exec: { command: "npm", args: ["run", "dev"] },
      port: helpers.readPortFromEnvFile(".env", "PORT"),
      pidFile: ".local-wt/dev-server.pid",
      logFile: ".local-wt/logs/dev-server.log",
      detectSuccess: (log) => log.includes("Server is ready on port"),
    },
  ],
  printSummary: ({ slot, servers }) =>
    `Dev servers started in slot ${slot.slot}${slot.owner ? ` (${slot.owner})` : ""}: ${servers
      .map((s) => `${s.server.name} :${s.port} (PID ${s.pid})`)
      .join(", ")}`,
});
```

## Build / test

```sh
npm install
npm run build
npm test
```
