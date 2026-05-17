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
npm run dev:up                               # start dev server in the background (no-op if already running here)
npm run dev:up -- --restart                  # stop the dev-server in this worktree if running, then start fresh
npm run dev:up -- --evict                    # if devLimit is reached, evict the oldest dev-server and start
npm run dev:list                             # active dev-servers across all worktrees
npm run dev:down                             # stop dev server (infrastructure stays up)
npm run setup-worktree -- --remove feat/42   # full teardown
```

## API

```ts
import { fileURLToPath } from "node:url";
import { runSetupWorktree, helpers } from "@paleo/worktree-env";

await runSetupWorktree({
  scriptPath: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
  basePort: 8100,
  portNames: ["server", "frontend", "db"],
  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",
  registryDir: ".local/wt-registry",
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
  preSetup: ({ currentWorktree, isMainWorktree, log }) => {
    // Idempotent. Bootstrap source files the kernel expects to find (e.g. seed `.env` from
    // `.env.example` on the main worktree). MUST NOT mutate the main worktree from a linked
    // worktree setup — bootstrap the main first via `setup-worktree --here`.
  },
  finalizeWorktree: async ({ currentWorktree }) => {
    // MUST be idempotent. Install deps, start containers, seed a database, etc.
  },
  printSummary: ({ slot, owner, ports }) =>
    `Slot ${slot}${owner ? ` (${owner})` : ""} — server :${ports.server}`,
});
```

The current branch is not persisted in the registry — worktrees can be checked out to a different branch at any time, so any stored value would go stale. Callbacks that need the live branch should call `git branch --show-current` (with `cwd` set to the worktree) themselves.

Setup runs in two phases: a fast foreground Part 1 creates the worktree and config, then a detached Part 2 runs `finalizeWorktree` and writes progress to `<runtimeDir>/wt-setup.log`. If Part 2 fails, `cd` into the worktree and run `setup-worktree --here` — it is idempotent and retries the finalize step. To block until Part 2 finishes (CI, agent orchestration), run `setup-worktree --wait` from inside the worktree (or `setup-worktree --wait --slot 8110` from anywhere) — exits 0 on `READY`, 1 on `FAILED`.

**Bootstrap the main worktree first.** Linked-worktree setup copies config sources from the main worktree, so the main must already have those files. Run `setup-worktree --here` once on the main checkout. Use `preSetup` (with `isMainWorktree === true`) to seed sources from examples or templates. `configFiles` entries are required by default; mark `optional: true` for sources that may legitimately be missing.

`--evict` is best-effort: the cap check and the subsequent register are not atomic, so two concurrent `dev:up --evict` from different worktrees can both pass the check and end up at `devLimit + 1` live servers. The window is narrow; if it matters, `dev:list` + `dev:down` deterministically.

```ts
import { runDevServer, helpers } from "@paleo/worktree-env";

await runDevServer({
  basePort: 8100,
  runtimeDir: ".local-wt",
  registryDir: ".local/wt-registry",
  devLimit: 5,
  servers: [
    {
      kind: "spawn",
      name: "dev",
      exec: { command: "npm", args: ["run", "dev"] },
      port: helpers.readPortFromEnvFile(".env", "PORT"),
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
