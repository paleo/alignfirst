{{#DEV}}
# Workspace & Dev Server — Guide

{{/DEV}}
{{^DEV}}
# Workspace — Guide

{{/DEV}}
{{#DEV}}
A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, infrastructure such as a database, and a dev server you can bring up or down. Ports and infrastructure arrive with the first `{{DEV_BASE}}` or `{{DEV}} setup`. Workspaces are isolated, so you can run several branches in parallel.

{{/DEV}}
{{^DEV}}
A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. Workspaces are isolated, so you can work on several branches in parallel.

{{/DEV}}
## Setting up a workspace

```sh
{{COMMANDS:setup}}
```

With `-c`, the new branch starts at the current worktree's HEAD (like `git switch -c`); `--from <ref>` accepts any commit-ish as the base. New branches have no upstream; set one when you first push. When the branch name is already taken, `setup -c` errors; add `--dedupe` to append `-2`, `-3`… instead.

With a branch argument, `setup` creates a worktree. Without one, it adopts the current Git worktree, including externally created worktrees under any parent directory. It preserves the path and branch, links shared directories, seeds config files, then runs the project's finalize step: install dependencies and build.

It streams to the setup log and **blocks until the log ends with `READY:` or `FAILED:`**, showing a progress ticker (`--verbose` follows the full log instead). Pass `-d`/`--detached` to return as soon as the worktree exists and continue the setup in the background; join it later with `wait`.

**Main worktree:** from a fresh clone, run `setup` once on the main worktree before creating linked worktrees.

{{#DEV}}
`setup --full` also runs the dev setup once the workspace is ready: ports, run files and infrastructure. A dev failure leaves the workspace ready and makes the command exit 1; `{{DEV}} setup` retries it.

{{/DEV}}
### External-tool hooks

Configure these generic hooks in the tool that creates and deletes your worktrees. Each runs **inside the target worktree**, using the project's runtime:

```sh
{{COMMANDS:hooks}}
```

Installation-first works when dependencies do not need seeded files. It uses the new branch's own wrapper. Blocking setup is the hook default; detached setup is an explicit alternative that must be joined with `wait` before cleanup.

### Recovery from a failed setup

If setup fails (check the setup log), do **not** delete the worktree. From inside it, `setup` is idempotent. Fix the issues and repeat until the log ends with `READY:`:

```sh
{{COMMANDS:recovery}}
```

When seeding must precede installation, or local dependencies are missing after a failure, stay inside the target worktree and discover the main wrapper through Git:

```sh
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_worktree=$(dirname "$common_dir")
node "$main_worktree/<path-to>/workspace.mjs" setup
```

Replace `<path-to>` with this project's wrapper location and apply its runtime selection. The main wrapper needs usable installed dependencies/build output. This fallback runs the **main worktree's recipe** against the target, rather than the new branch's recipe.

## Inspecting workspaces

```sh
{{COMMANDS:inspect}}
```

Names in `list` are opaque **registered names**, usually directory basenames and suffixed when another path already owns that name. Paths select exactly; there is no basename-search fallback. A registered name also selects an orphan whose directory is gone. Independent clones have independent registries.

All participating duplicate-basename worktrees need the upgraded package. Consumer Compose wrappers must explicitly select the registered project before relying on this isolation. Ordinary names and default resource names stay compatible; there is no automatic bulk upgrade or teardown.

## Cleaning up without deletion

```sh
{{COMMANDS:teardown}}
```

`teardown` stops recorded services, purges configured infrastructure (including volumes where configured), and releases registration and ports. It preserves worktree files, installed dependencies, seeded/runtime files, shared links and Git state, even when dirty. Main-worktree teardown preserves the shared registry directory and other entries. It is not a filesystem reset.

Wait for pending setup before cleanup. Failed or partial setups are eligible; teardown has no force or all mode. Repeating it succeeds without purging again. Hooks that swallow purge errors remain best-effort; a zero exit does not prove external-resource deletion.

Run `setup` afterward to adopt and finalize the retained worktree again. Former names, collision suffixes and ports are not reserved after removal from the registry.

{{#DEV}}
Subsequent `{{DEV}} setup` provisions it again.

{{/DEV}}
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

`remove`, `teardown` and `status` default to the current Git worktree, including from nested directories. Select another by exact path or registered name from `list`. Removal adds Git worktree deletion to cleanup; teardown leaves deletion to you or your external tool.

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

A workspace's ports are allocated at its first dev start, stay fixed, and are listed by `{{WS}} list` / `status`.

**Concurrent cap.** `dev` / `dev up` cap simultaneously running dev-servers. At the cap, the start errors with a table of active servers and exits non-zero. Make room via `down` in another worktree, `down --all`, or `up --evict` (stops the oldest live one and starts).

**Two-tier shutdown.** `down` (and a foreground CTRL+C) stops dev processes and configured callbacks, which may stop containers. Destructive infrastructure purge belongs to `workspace teardown`, `remove` and `prune`.

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
