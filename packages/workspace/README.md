# @paleo/workspace

Run multiple local dev environments side by side, one per git worktree, with isolated ports, databases, and config files. Built for branches worked in parallel, by humans or AI agents.

Each project writes two custom scripts on top, using these entry points:

- `runWorkspace(config)` — worktree lifecycle (setup / remove).
- `runDevServer(config)` — dev-server start (foreground or background) / stop / list.

## Setup

The `alignfirst-setup-guide` skill is a setup-time companion. Install the skill (globally or locally):

```bash
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then, in your project, ask your agent:

```text
Use your alignfirst-setup-guide skill. Set up worktree-based local environments in this project.
```

The agent reads the skill, adapts the reference scripts to your stack, installs `@paleo/workspace` as a dev dependency, and wires the npm scripts. After that, you can uninstall the skill, it won't be used by your project anymore.

## Workflow

```sh
npm run workspace -- setup feat/42 -c        # new branch + worktree + isolated env
npm run workspace -- setup feat/42 -c --go   # …then drop into a shell there (exit to return)
npm run dev                             # foreground: stream logs, CTRL+C stops; attaches if already running
npm run dev -- up                       # start in the background (no-op if already running here)
npm run dev -- up --restart             # stop the dev-server in this worktree if running, then start fresh
npm run dev -- up --evict               # if devLimit is reached, evict the oldest dev-server and start
npm run dev -- restart                  # stop the dev-server in this worktree if running, then start in the background
npm run dev -- status                   # report whether this worktree's dev-server is UP or DOWN
npm run dev -- list                     # active dev-servers across all worktrees
npm run dev -- down                     # stop dev server (infrastructure stays up)
npm run workspace -- remove ../my-wt    # full teardown (by dir path/name, --slot, or omit for current)
npm run workspace -- prune              # heal workspaces whose worktree was deleted out-of-band
npm run workspace -- --guide            # full operating guide (workspace + dev-server)
```

`--guide` prints the complete workspace + dev-server procedures in your package-manager's syntax. Point agents at it instead of maintaining a separate doc.

## API

```ts
import { fileURLToPath } from "node:url";
import { runWorkspace, helpers } from "@paleo/workspace";

await runWorkspace({
  scriptPath: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
  basePort: 8100,
  portNames: ["server", "frontend", "db"],
  sharedDirs: [".local", ".plans"],
  runtimeDir: ".local-wt",
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
    // worktree setup — bootstrap the main first via `workspace setup`.
  },
  finalizeWorktree: async ({ currentWorktree }) => {
    // MUST be idempotent. Install deps, start containers, seed a database, etc.
  },
  printSummary: ({ slot, branch, ports, isMainWorktree, status }) =>
    `Type:   ${isMainWorktree ? "main" : "linked"}\nStatus: ${status}\nSlot:   ${slot}\nBranch: ${branch}\nServer: :${ports.server}`,
});
```

`branch` is resolved live from the worktree on each call (not persisted in the registry — `git checkout` makes any stored value stale). For detached HEAD or missing directory, it falls back to `"(detached)"`. `status` is the slot's finalize status: `"pending"` until `finalizeWorktree` succeeds, then `"ready"` (or `"failed"`).

Setup runs in two phases: a fast foreground Part 1 creates the worktree and config, then a detached Part 2 runs `finalizeWorktree` and writes progress to `<runtimeDir>/logs/workspace-setup.log`. If Part 2 fails, `cd` into the worktree and run `workspace setup` — it is idempotent and retries the finalize step. To block until Part 2 finishes (CI, agent orchestration), run `workspace wait` from inside the worktree (or `workspace wait --slot 8110` from anywhere) — exits 0 on `READY`, 1 on `FAILED`.

**Bootstrap the main worktree first.** Linked-worktree setup copies config sources from the main worktree, so the main must already have those files. Run `workspace setup` once on the main checkout. Use `preSetup` (with `isMainWorktree === true`) to seed sources from examples or templates. `configFiles` entries are required by default; mark `optional: true` for sources that may legitimately be missing.

`--evict` is best-effort: the cap check and the subsequent register are not atomic, so two concurrent `dev up --evict` from different worktrees can both pass the check and end up at `devLimit + 1` live servers. The window is narrow; if it matters, `dev list` + `dev down` deterministically.

```ts
import { runDevServer, helpers } from "@paleo/workspace";

await runDevServer({
  basePort: 8100,
  runtimeDir: ".local-wt",
  devLimit: 5,
  servers: [
    {
      kind: "spawn",
      name: "dev",
      // Not `dev` — the workspace wrapper script is named `dev`, so `npm run dev` would recurse.
      exec: { command: "npm", args: ["run", "dev:app"] },
      port: helpers.readPortFromEnvFile(".env", "PORT"),
      detectSuccess: (log) => log.includes("Server is ready on port"),
    },
  ],
  printSummary: ({ slot, servers }) =>
    `Dev servers started in slot ${slot.slot}: ${servers
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
