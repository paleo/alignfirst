{{#DEV}}
# Workspace & Dev Server — Guide

{{/DEV}}
{{^DEV}}
# Workspace — Guide

{{/DEV}}
{{#PORTS}}
A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated, so you can run several branches in parallel.

{{/PORTS}}
{{^PORTS}}
A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. Workspaces are isolated, so you can work on several branches in parallel.

{{/PORTS}}
## Setting up a workspace

```sh
{{COMMANDS:setup}}
```

With `-c`, the new branch starts at the current worktree's HEAD (like `git switch -c`); `--from <ref>` accepts any commit-ish as the base. When the branch name is already taken, `setup -c` errors; add `--dedupe` to append `-2`, `-3`… instead.

{{#PORTS}}
`setup` creates the worktree (branch, ports, symlinks, config files), then runs the project's finalize step: install dependencies, build, provision the database.

{{/PORTS}}
{{^PORTS}}
`setup` creates the worktree (branch, symlinks, config files), then runs the project's finalize step: typically install dependencies and build.

{{/PORTS}}
It streams to the setup log and **blocks until the log ends with `READY:` or `FAILED:`**, showing a progress ticker (`--verbose` follows the full log instead). Pass `-d`/`--detached` to return as soon as the worktree exists and continue the setup in the background; join it later with `wait`.

**Main worktree:** from a fresh clone, run `setup` once on the main worktree before creating linked worktrees.

### Recovery from a failed setup

If setup fails (check the setup log), do **not** delete the worktree. From inside it, `setup` is idempotent. Fix the issues and repeat until the log ends with `READY:`:

```sh
{{COMMANDS:recovery}}
```

**Edge case** — if setup errors with `ERR_MODULE_NOT_FOUND: Cannot find package '@paleo/workspace'`, the worktree never got `node_modules/` (setup failed before the install). Fall back to the main worktree's wrapper directly:

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

{{#DEV}}
Stops the dev server (if running), tears down infrastructure, drops the registry entry, and removes the worktree. The local branch is always kept.

{{/DEV}}
{{^DEV}}
Tears down infrastructure, drops the registry entry, and removes the worktree. The local branch is always kept.

{{/DEV}}
Removal refuses on uncommitted changes. Pass `--force` to discard them. When removing the current worktree, the script prints the main worktree path; `cd` there afterward.

`remove` and `status` pick a workspace the same way: omit to act on the current worktree, or target another by its **directory** (a path or just the basename). The basename is the workspace name in the registry, so it still reaches an orphan whose directory is already gone.

**NEVER** delete a branch unless the user explicitly requests it.

### Healing orphaned workspaces

A workspace is **orphaned** when its worktree dir was deleted out-of-band (manual `rm -rf`, bare `git worktree remove`). `list` auto-drops the safe ones (no live dev-server). For the rest:

```sh
{{COMMANDS:prune}}
```

### A worktree without setup

When you only want a bare worktree (no symlinks, no config files, no finalize step), use the `git worktree` CLI directly.

{{#DEV}}
## Dev server

`{{DEV_BASE}}` starts the dev server in the **foreground**: it holds the terminal, tails logs, and stops cleanly on CTRL+C. For agents, `up` starts it in the **background** and returns once ready.

```sh
{{COMMANDS:dev}}
```

**Concurrent cap.** `dev` / `dev up` cap simultaneously running dev-servers. At the cap, the start errors with a table of active servers and exits non-zero. Make room via `down` in another worktree, `down --all`, or `up --evict` (stops the oldest live one and starts).

**Two-tier shutdown.** `down` (and a foreground CTRL+C) only kill dev-server processes. They leave infrastructure (Docker containers, databases) running so restarts stay fast. Full infrastructure cleanup happens via `workspace remove` when tearing the worktree down entirely.

### Driving the dev server in another worktree

```sh
{{SNIPPET:drive-dev}}
```

{{/DEV}}
## Directory layout

- `{{RUNTIME_DIR}}/` — per-worktree runtime data (not shared). Names below are fixed by the package:
{{#DEV}}
  - `logs/` — dev-server + setup logs.
{{/DEV}}
{{^DEV}}
  - `logs/` — setup logs.
{{/DEV}}
  - `{{REGISTRY_SUBDIR}}/` — the registry. Symlinked to the main worktree in linked worktrees.
{{LAYOUT:shared}}
