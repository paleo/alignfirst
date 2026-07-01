# Workspace & Dev Server — Guide

A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated, so you can run several branches in parallel.

## Setting up a workspace

```sh
{{COMMANDS:setup}}
```

With `-c`, the new branch starts at the current worktree's HEAD (like `git switch -c`); `--from <ref>` accepts any commit-ish as the base.

The foreground command creates the worktree, assigns a port slot, sets up symlinks, and generates config files. The remaining steps (dependency install, build, database provisioning) run **detached in the background** and stream to the setup log, ending with a `READY:` or `FAILED:` banner.

By default `setup` **blocks** until that banner (former `--wait` behavior). When a callback URL is configured — `WORKSPACE_CALLBACK_URL` (or `--callback-url`), i.e. an OpenClaw caller — it instead **returns immediately** and fires a completion callback once finalize reaches READY/FAILED; pass `--session-key` (from the `session_status` tool) to target it. OpenClaw must **not** poll: it goes available and waits for the callback.

**Main worktree:** from a fresh clone, run `setup` once on the main worktree before creating linked worktrees.

### Recovery from a failed setup

If the background finalize fails (check the setup log), do **not** delete the worktree. From inside it, `setup` is idempotent — repeat until the log ends with `READY:`:

```sh
{{COMMANDS:recovery}}
```

**Edge case** — if setup errors with `ERR_MODULE_NOT_FOUND: Cannot find package '@paleo/workspace'`, the worktree never got `node_modules/` (finalize failed before the install). Fall back to the main worktree's wrapper directly:

```sh
cd <failed-worktree>
node <main-worktree>/<path-to>/workspace.mjs setup
```

## Inspecting workspaces

```sh
{{COMMANDS:inspect}}
```

## Removing a workspace

```sh
{{COMMANDS:remove}}
```

Stops the dev server (if running), tears down infrastructure, frees the slot, and removes the worktree. The local branch is always kept. Removal refuses on uncommitted changes — pass `--force` to discard them. When removing the current worktree, the script prints the main worktree path; `cd` there afterward.

`remove`, `status`, and `wait` pick a workspace the same way: omit to act on the current worktree, or target another by its **directory** (a path or just the basename) or `--slot <port>`. Slot also reaches an orphan whose directory is already gone.

**NEVER** delete a branch unless the user explicitly requests it.

### Healing orphaned workspaces

A workspace is **orphaned** when its worktree dir was deleted out-of-band (manual `rm -rf`, bare `git worktree remove`). `list` auto-drops the safe ones (no live dev-server). For the rest:

```sh
{{COMMANDS:prune}}
```

### A worktree without setup

When you only want a worktree (no ports, no build, no config), use the `git worktree` CLI directly.

## Dev server

`{{DEV_BASE}}` starts the dev server in the **foreground**: it holds the terminal, tails logs, and stops cleanly on CTRL+C. For agents, `up` starts it in the **background** and returns once ready.

```sh
{{COMMANDS:dev}}
```

**Concurrent cap.** `dev` / `dev up` cap simultaneously running dev-servers. At the cap, the start errors with a table of active servers and exits non-zero. Free a slot via `down` in another worktree, `down --all`, or `up --evict` (stops the oldest live one and starts).

**Two-tier shutdown.** `down` (and a foreground CTRL+C) only kill dev-server processes — they leave infrastructure (Docker containers, databases) running so restarts stay fast. Full infrastructure cleanup happens via `workspace remove` when tearing the worktree down entirely.

### Driving the dev server in another worktree

```sh
{{SNIPPET:drive-dev}}
```

## Directory layout

- `{{RUNTIME_DIR}}/` — per-worktree runtime data (not shared). Names below are fixed by the package:
  - `logs/` — dev-server + setup logs.
  - `{{REGISTRY_SUBDIR}}/` — the registry. Symlinked to the main worktree in linked worktrees.
{{LAYOUT:shared}}
