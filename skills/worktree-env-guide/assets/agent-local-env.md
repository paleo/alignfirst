---
title: Local Environment Management for Agents
summary: Agent procedures for creating/removing worktrees, starting/stopping the dev server.
read_when:
  - setting up or removing a worktree
  - starting or stopping the dev server
---

# Local Environment Management for Agents

Examples below use `npm` syntax. Adapt for your package manager — flag-forwarding rules (e.g. the `--` separator) vary.

## Setting Up a Local Environment

When the user asks to "set up a new local environment" or "set up a new worktree":

```sh
npm run setup-worktree -- --create fix/123    # new branch + worktree (dedup: appends -2, -3… if taken)
npm run setup-worktree -- --use fix/123       # new worktree on an existing branch
npm run setup-worktree -- --here              # set up the current worktree (idempotent — also the retry path)
```

<!-- ADAPT: Update the setup command if your project uses a different task runner.
     Document any project-specific ports or URLs the developer should know about. -->

The foreground command creates the worktree, assigns a port slot, sets up symlinks, and generates config files. The remaining steps (dependency install, build, database provisioning) run **detached in the background** and stream progress to `<runtimeDir>/wt-setup.log`, ending with a `READY:` or `FAILED:` banner.

```sh
npm run setup-worktree -- --wait --slot 8110  # block until ready (exit 0) or failed (exit 1)
```

**Main worktree:** From a fresh clone, run `npm run setup-worktree -- --here` once on the main worktree. The main worktree must be bootstrapped before creating linked worktrees.

### Recovery from a Failed Setup

If the background finalize fails (check `<runtimeDir>/wt-setup.log`), do **not** delete the worktree. From inside it:

```sh
npm run setup-worktree -- --here --wait    # retry the finalize step
```

- `--here` is idempotent. Repeat until the log ends with `READY: ...`.
- `--wait` blocks until READY or FAILED.

**Edge case** — if `--here` errors with `ERR_MODULE_NOT_FOUND: Cannot find package '@paleo/worktree-env'`, the worktree never got `node_modules/` because finalize failed before the dependency install. Fall back to the main worktree's wrapper:

```sh
cd <failed-worktree>
node <main-worktree>/scripts/local-env/setup-worktree.mjs --here
```

### Take over an Existing Worktree

```sh
npm run setup-worktree -- --info  # print the current worktree's summary (ports, branch, readiness)
npm run setup-worktree -- --info --slot 8110  # same, for another worktree
```

### Slot Owner

Each slot records an optional owner (free-form label). An AI bot passes its Discord username; on a personal laptop, omit it.

```sh
npm run setup-worktree -- --create fix/123 --owner alice
npm run setup-worktree -- --set-owner bob   # update later, no rebuild
```

### Removing a Local Environment

```sh
npm run setup-worktree -- --remove fix/123    # remove by branch name
npm run setup-worktree -- --remove-here       # remove the current worktree
npm run setup-worktree -- --remove fix/123 --no-remote-check # skip remote branch check
```

Stops the dev server (if running), frees the slot, and removes the worktree.

By default, it verifies the branch has been removed from the remote first. Use `--no-remote-check` to skip that. With `--remove-here`, the script prints the main worktree path. You'll have to run `cd <main-worktree>` afterward.

**NEVER** delete a branch unless the user explicitly requests it.

### Creating a Worktree Without Setup

When the user only wants a worktree (no ports, no build, no config), use `git worktree` CLI directly.

<!-- ADAPT: Replace REPONAME with your repository name in the example if you add one. -->

## Dev Server

`npm run dev:up` starts the dev server in the background with logs redirected to a file, and returns once the server is ready.

```sh
npm run dev:up             # Start in background
npm run dev:down           # Stop the background server (this worktree only)
npm run dev:list           # List active dev-servers across all worktrees
npm run dev:down -- --all  # Stop every active dev-server
npm run dev:up -- --evict  # If the cap is full, stop the oldest dev-server and start
```

<!-- ADAPT: Document where the logs are stored (e.g., .local-wt/logs/).
     Mention any project-specific URLs to open after starting. -->

Logs are stored in `.local-wt/logs/` (per-worktree).

The script detects port conflicts: it will refuse to start if a dev server is already running.

### Concurrent dev-server cap

`dev:up` enforces a cap on simultaneously running dev-servers. When the cap is reached, `dev:up` errors with a table of active servers and exits non-zero. Free a slot via `npm run dev:down` in another worktree, or via `npm run dev:down -- --all`.

**Two-tier shutdown:** `dev:down` (and `dev:down --all`) only kills dev server processes — it intentionally leaves infrastructure (Docker containers, databases) running so restarts are fast. Full infrastructure cleanup happens via `setup-worktree --remove` when tearing down the worktree entirely.

### Start the dev server in a specific worktree

```sh
git worktree list                    # 1. find the worktree directory
cd <worktree-dir> && npm run dev:up  # 2. start the dev server
# 3. read the log file (path printed on start) to confirm startup and find URLs
npm run dev:down                     # 4. stop when done (same directory)
```

## Directory Layout

<!-- ADAPT: List your shared and per-worktree directories. -->

- **`.local/`** — Shared across worktrees (symlinked). Lightweight files: personal notes, `wt-registry/slots.json` (slot registry; up to 19 linked-worktree slots + the implicit main worktree), `wt-registry/dev-servers.json` (live dev-server registry).
- **`.local-wt/`** — Per-worktree. Runtime data: databases, caches, `logs/` (dev server logs).
