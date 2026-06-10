---
title: Workspace
summary: Agent procedures for creating/removing workspaces, starting/stopping the dev server, and interacting with GitHub.
read_when:
  - setting up or removing a workspace
  - starting or stopping the dev server
  - pushing code or creating a pull request
---

# Workspace

A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated from one another, so you can run several branches in parallel.

## Setting Up a Workspace

When the user asks to "set up a new workspace" or "set up a new worktree":

```sh
pnpm workspace setup ABC-123/fix -c    # new branch + worktree (dedup: appends -2, -3… if taken)
pnpm workspace setup ABC-456/fix -c --from origin/ABC-123/fix   # new branch based on another branch
pnpm workspace setup ABC-123/fix       # worktree on an existing branch
pnpm workspace setup                   # set up the current worktree (idempotent — also the retry path)
```

With `-c`, the new branch starts at the current worktree's HEAD (like `git switch -c`); `--from <ref>` accepts any commit-ish as the base.

The foreground command creates the worktree, assigns a port slot, and generates config files. The remaining steps (`pnpm install`, build, Docker PostgreSQL, migrations, seed) run **detached in the background** and stream progress to `.local-wt/logs/workspace-setup.log`, ending with a `READY:` or `FAILED:` banner.

```sh
pnpm workspace wait --slot 6510   # block until ready (exit 0) or failed (exit 1)
```

**Main worktree:** From a fresh clone, run `pnpm workspace setup` once on the main worktree. The main worktree must be bootstrapped before creating linked worktrees.

### Recovery from a failed setup

If the background finalize fails (check `.local-wt/logs/workspace-setup.log`), do **not** delete the worktree. From inside it:

```sh
pnpm workspace setup --wait    # retry the finalize step
```

- `workspace setup` (no branch) is idempotent. Repeat until the log ends with `READY: ...`.
- `--wait` blocks until READY or FAILED.

**Edge case** — if it errors with `ERR_MODULE_NOT_FOUND: Cannot find package '@paleo/workspace'`, the worktree never got `node_modules/` because finalize failed before `pnpm install`. Fall back to the main worktree's wrapper:

```sh
cd <failed-worktree>
node <main-worktree>/scripts/workspace/workspace.mjs setup
```

### Listing Registered Workspaces

```sh
pnpm workspace list  # print all registered worktrees (slot, type, status, branch, path, owner, created)
```

### Take over an existing workspace

```sh
pnpm workspace status               # print the current worktree's summary (type, ports, branch, readiness)
pnpm workspace status --slot 6510   # same, for another worktree
```

### Slot Owner

Each slot records an optional owner (free-form label). An AI bot passes its Discord username; on a personal laptop, omit it.

```sh
pnpm workspace setup ABC-123/fix -c --owner alice
pnpm workspace set-owner bob        # update later, no rebuild
```

### Removing a Workspace

```sh
pnpm workspace remove ABC-123/fix    # remove by branch name
pnpm workspace remove                # remove the current worktree (from inside it)
```

Stops the dev servers (if running), tears down the Docker container and volumes, frees the slot, and removes the worktree. The local branch is always kept.

Removal refuses when the worktree has uncommitted changes; pass `--force` to discard them. When run from inside the worktree, the script prints the main worktree path. You'll have to run `cd <main-worktree>` afterward.

**NEVER** delete a branch unless the user explicitly requests it.

### Creating a Worktree Without Setup

When the user only wants a worktree (no ports, no build, no config), use `git worktree` CLI directly.

## Dev Server

`pnpm dev up` starts the app dev server in the **foreground**: it holds the terminal, tails the log, and stops cleanly on CTRL+C. For agents, `pnpm dev up` starts it in the **background** with logs redirected to a file, and returns once the server is ready.

```sh
pnpm dev up         # Start in the background (this worktree)
pnpm dev down       # Stop the background server in this worktree
pnpm dev list       # List all running dev-servers across worktrees
pnpm dev down --all # Stop every running dev-server across worktrees
pnpm dev            # Start in the foreground (holds the terminal, stops on CTRL+C)
```

The script detects port conflicts: it will refuse to start if a dev server is already running.

Logs are stored in `.local-wt/logs/` and `.local-wt/` (per-worktree).

`dev` / `dev up` enforce a cap on simultaneously running dev-servers. When the cap is reached, the start errors with a table of active servers and exits non-zero. Free a slot via `pnpm dev down` in another worktree, `pnpm dev down --all`, or re-run with `pnpm dev up --evict` to stop the oldest live dev-server across worktrees and start the new one.

**Two-tier shutdown:** `dev down` and `dev down --all` (and a foreground CTRL+C) only kill dev server processes — they intentionally leave infrastructure (Docker containers, databases) running so restarts are fast. Full infrastructure cleanup happens via `workspace remove` when tearing down the workspace entirely.

### Start the dev server in a specific worktree

```sh
git worktree list                   # 1. find the worktree directory
cd <worktree-dir> && pnpm dev up    # 2. start the dev server in the background
# 3. read the log files (paths printed on start) to confirm startup and find URLs
pnpm dev down                       # 4. stop when done (same directory)
```

After starting, report the auto-login URL to the user: `http://localhost:{frontendPort}/auth/local?email=superadmin@test.dev`

## GitHub — Creating a Pull Request

Use **gh** (the GitHub CLI) for remote operations. PR and MR are equivalent terms.

When the user asks to create a PR:

1. **Pre-flight checks.** Run `pnpm lint:fix`, `pnpm tsc`, and `pnpm test`. All must pass before proceeding.
2. **Commit and push.** If there are uncommitted changes (including files modified by `lint:fix`), commit them following the conventional commit format from `AGENTS.md` (e.g. `feat: [ABC-1234] very short description`). Then push the branch (`-u` if it has no upstream).
3. **Generate the PR description.** Use `alignfirst` to find the plan directory (`.plans/<ticketId>/`). If a description file (`*-description.md`) already exists **and** is the last file in the directory (i.e. no further work was done after it), use its content directly. Otherwise, run the `aldescription` protocol from the `alignfirst` skill to generate a new one. Use the description body as the PR body and the suggested commit message as the PR title.
4. **Create the PR** with `gh pr create`, targeting `develop`:

   ```sh
   gh pr create \
     --title "fix: [ABC-123] very short description" \
     --body "$description" \
     --base develop
   ```

**Important:** Never create a PR without explicit user request.

## Directory Layout

- **`.local/`** — Shared across worktrees (symlinked). It's the right place for any gitignored working files (e.g. personal notes…).
- **`.local-wt/`** — Per-worktree. Runtime data: databases, caches, `logs/` (dev server logs).
  - `shared-registry/` — The workspace registry. Symlinked to the main worktree in linked worktrees.
- **`.plans/`** — Shared across worktrees (symlinked). Task planning files.
