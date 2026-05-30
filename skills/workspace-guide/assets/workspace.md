---
title: Workspace
summary: Procedures for creating/removing workspaces (worktrees) and starting/stopping their dev server.
read_when:
  - setting up or removing a workspace or worktree
  - starting or stopping the dev server
---

# Workspace

A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated from one another, so you can run several branches in parallel.

Examples below use `npm` syntax. Adapt for your package manager — flag-forwarding rules (e.g. the `--` separator) vary.

## Setting Up a Workspace

When the user asks to "set up a new workspace" or "set up a new worktree":

```sh
npm run workspace -- setup fix/123 -c    # new branch + worktree (dedup: appends -2, -3… if taken)
npm run workspace -- setup fix/123       # new worktree on an existing branch
npm run workspace -- setup               # set up the current worktree (idempotent — also the retry path)
```

<!-- ADAPT: Update the setup command if your project uses a different task runner.
     Document any project-specific ports or URLs the developer should know about. -->

The foreground command creates the worktree, assigns a port slot, sets up symlinks, and generates config files. The remaining steps (dependency install, build, database provisioning) run **detached in the background** and stream progress to `<runtimeDir>/logs/workspace-setup.log`, ending with a `READY:` or `FAILED:` banner.

```sh
npm run workspace -- wait --slot 8110  # block until ready (exit 0) or failed (exit 1)
```

**Main worktree:** From a fresh clone, run `npm run workspace -- setup` once on the main worktree. The main worktree must be bootstrapped before creating linked worktrees.

### Recovery from a Failed Setup

If the background finalize fails (check `<runtimeDir>/logs/workspace-setup.log`), do **not** delete the worktree. From inside it:

```sh
npm run workspace -- setup --wait    # retry the finalize step
```

- `workspace setup` is idempotent. Repeat until the log ends with `READY: ...`.
- `--wait` blocks until READY or FAILED.

**Edge case** — if `workspace setup` errors with `ERR_MODULE_NOT_FOUND: Cannot find package '@paleo/workspace'`, the worktree never got `node_modules/` because finalize failed before the dependency install. Fall back to the main worktree's wrapper:

```sh
cd <failed-worktree>
node <main-worktree>/scripts/workspace/workspace.mjs setup
```

### Listing Registered Worktrees

```sh
npm run workspace -- list  # print all registered worktrees (slot, type, status, branch, path, owner, created)
```

### Take over an Existing Worktree

```sh
npm run workspace -- status  # print the current worktree's summary (ports, branch, readiness)
npm run workspace -- status --slot 8110  # same, for another worktree
```

### Slot Owner

Each slot records an optional owner (free-form label). An AI bot passes its Discord username; on a personal laptop, omit it.

```sh
npm run workspace -- setup fix/123 -c --owner alice
npm run workspace -- set-owner bob   # update later, no rebuild
```

### Removing a Workspace

```sh
npm run workspace -- remove fix/123    # remove by branch name
npm run workspace -- remove            # remove the current worktree
npm run workspace -- remove fix/123 --no-remote-check # skip remote branch check
```

Stops the dev server (if running), frees the slot, and removes the worktree.

By default, it verifies the branch has been removed from the remote first. Use `--no-remote-check` to skip that. When run from inside the worktree (`workspace remove` with no branch), the script prints the main worktree path. You'll have to run `cd <main-worktree>` afterward.

**NEVER** delete a branch unless the user explicitly requests it.

### Creating a Worktree Without Setup

When the user only wants a worktree (no ports, no build, no config), use `git worktree` CLI directly.

<!-- ADAPT: Replace REPONAME with your repository name in the example if you add one. -->

## Dev Server

`npm run dev` starts the dev server in the **foreground**: it holds the terminal, tails the logs to stdout, and stops cleanly on CTRL+C. For agents, `npm run dev -- up` starts it in the **background** with logs redirected to a file, and returns once the server is ready.

```sh
npm run dev                # Start in the foreground (holds the terminal, stops on CTRL+C)
npm run dev -- up          # Start in the background (this worktree)
npm run dev -- restart     # Stop this worktree's dev-server if running, then start in the background
npm run dev -- status      # Report whether this worktree's dev-server is UP or DOWN
npm run dev -- down        # Stop the dev-server (this worktree only)
npm run dev -- list        # List active dev-servers across all worktrees
npm run dev -- down --all  # Stop every active dev-server
npm run dev -- up --evict  # If the cap is full, stop the oldest dev-server and start
```

<!-- ADAPT: Document where the logs are stored (e.g., .local-wt/logs/).
     Mention any project-specific URLs to open after starting. -->

Logs are stored in `.local-wt/logs/` (per-worktree).

The script detects port conflicts: it will refuse to start if a dev server is already running.

### Concurrent dev-server cap

`dev` / `dev up` enforce a cap on simultaneously running dev-servers. When the cap is reached, the start errors with a table of active servers and exits non-zero. Free a slot via `npm run dev -- down` in another worktree, or via `npm run dev -- down --all`.

**Two-tier shutdown:** `dev down` (and `dev down --all`) only kills dev server processes — it intentionally leaves infrastructure (Docker containers, databases) running so restarts are fast. Full infrastructure cleanup happens via `workspace remove` when tearing down the worktree entirely.

### Start the dev server in a specific worktree

```sh
git worktree list                       # 1. find the worktree directory
cd <worktree-dir> && npm run dev -- up  # 2. start the dev server in the background
# 3. read the log file (path printed on start) to confirm startup and find URLs
npm run dev -- down                     # 4. stop when done (same directory)
```

## Directory Layout

<!-- ADAPT: List your shared and per-worktree directories. -->

- **`.local/`** — Shared across worktrees (symlinked). It's the right place for any gitignored working files (e.g. personal notes…).
  - `_workspace-registry/slots.json` — Slot registry; main worktree at `basePort` plus linked-worktree slots.
  - `_workspace-registry/dev-servers.json` — Live dev-server registry.
- **`.local-wt/`** — Per-worktree. Runtime data: databases, caches, `logs/` (dev server logs).
- **`.plans/`** — Shared across worktrees (symlinked). Task planning files.
