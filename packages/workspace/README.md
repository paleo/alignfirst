# @paleo/workspace

Run multiple local dev environments side by side, one per git worktree, with isolated ports, databases, and config files. Built for branches worked in parallel, by humans or AI agents.

## What is a workspace?

A **workspace** is one isolated stream of work. It is close to [Conductor's](https://www.conductor.build/docs/concepts/workspaces-and-branches) sense of the word, with the dev-server setup made explicit. It bundles:

- a **branch**;
- a **git worktree** checked out to it;
- an optional **dev-server** setup:
  - a **port range** (a block of contiguous ports).
  - the **gitignored files** for configuration (`.env`, compose files, …) rewritten to that range, so the dev servers run in isolation.

Several workspaces run at once without colliding, so you can develop, test, or hand a branch to an agent in parallel.

## Setup

The `alignfirst-setup-guide` skill is a setup-time companion. Temporarily install the skill (globally or locally):

```bash
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then, in your project, ask your agent:

```md
Use your *alignfirst-setup-guide* skill. Set up *workspaces* in this project.
```

The agent reads the skill, adapts the reference scripts to your stack, installs `@paleo/workspace` as a dev dependency, and wires the npm/pnpm/yarn scripts. After that, you can uninstall the skill, it won't be used by your project anymore.

Setup writes one or two wrapper scripts on these entry points:

- `runWorkspace(config)` — worktree lifecycle (setup / remove).
- `runDevServer(config)` (optional) — dev-server start (foreground or background) / stop / list.

### Migration from the old `slots.json` registry

See the [CHANGELOG.md](https://github.com/paleo/alignfirst/blob/main/packages/workspace/CHANGELOG.md#0300).

## Workflow

```sh
npm run workspace -- setup -c feat/42   # new branch + worktree + isolated env
npm run workspace -- list               # every registered workspace
npm run dev                             # foreground: stream logs, CTRL+C stops; attaches if already running
npm run dev -- up                       # start in the background (no-op if already running here)
npm run dev -- up --restart             # stop the dev-server in this worktree if running, then start fresh
npm run dev -- up --evict               # if maxConcurrentDevServers is reached, evict the oldest dev-server and start
npm run dev -- restart                  # stop the dev-server in this worktree if running, then start in the background
npm run dev -- status                   # report whether this worktree's dev-server is UP or DOWN
npm run dev -- list                     # active dev-servers across all worktrees
npm run dev -- down                     # stop dev server (infrastructure stays up)
npm run workspace -- remove ../my-wt    # full teardown (by dir path or name; omit for the current worktree)
npm run workspace -- prune              # heal workspaces whose worktree was deleted out-of-band
npm run workspace -- --guide            # full operating guide (workspace + dev-server)
```

`--guide` prints the complete procedures in your package-manager's syntax, adapted to your config — a project without ports or a dev server gets a guide without those sections. Point agents at it instead of maintaining a separate doc.

## API Reference

The documentation on `runWorkspace` and `runDevServer` (ports, `gitignoredFiles`, `finalizeWorkspace`, dev-server descriptors, and more), along with the design rationale, lives in the skill's [workspace-setup.md](https://github.com/paleo/alignfirst/blob/main/skills/alignfirst-setup-guide/references/workspace-setup.md) reference.
