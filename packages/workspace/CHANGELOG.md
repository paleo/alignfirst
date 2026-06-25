# @paleo/workspace

## 0.25.0

### Minor Changes

- Remove the unused workspace `owner` feature (`--owner`, `set-owner`, the OWNER column, and `owner` in the contexts/registry). Breaking: drop `owner` from `printSummary`.

## 0.24.0

### Minor Changes

- Select a workspace consistently across `remove`, `status`, `wait`, and `set-owner`: omit for the current worktree, give a directory (path or basename), or `--slot <port>`. Breaking: `remove <branch>` is gone — use the directory or `--slot`.

## 0.23.0

### Minor Changes

- `configFiles`: `source` is now required and discriminated by `kind` (`mainWorktree`, `newWorktree`, `content`); `patch` is now optional.

## 0.22.0

### Minor Changes

- Tear down an orphaned worktree's infrastructure on `prune`/`remove`. `finalizeWorktree` may return `{ extra }`, persisted on the slot and handed back to `purgeInfrastructure` (now also called for orphans, by name).

## 0.21.0

### Minor Changes

- 62afc9a: Add `--go` to `workspace setup`: open an interactive shell in the new worktree (exit to return). Falls back to printing a `cd` hint when `$SHELL` is unset or stdin is not a tty.

## 0.20.0

### Minor Changes

- 398e372: Self-heal orphaned workspaces (worktree deleted out-of-band). New `workspace prune` stops their dev-servers, drops the registry entries, and runs `git worktree prune`. `workspace list` auto-prunes the safe case; `workspace remove` now cleans up an already-deleted worktree too.
- 1273837: Self-documenting CLI: `workspace --guide` prints the full operating guide (every command, the directory layout, the guardrails), rendered in the project's package-manager syntax. Consumers point agents at the command instead of maintaining a separate `docs/workspace.md`.

## 0.19.1

### Patch Changes

- 4396c78: Point README Setup at the `alignfirst-setup-guide` skill.

## 0.19.0

### Minor Changes

- Rename the registry directory: `${runtimeDir}/shared-registry` → `${runtimeDir}/workspace-registry`. `workspace migrate-0.16 <old-registryDir>` now merges into the new location and accepts any old registry path — including a 0.17/0.18 `${runtimeDir}/shared-registry` — and relinks worktrees.

## 0.18.0

### Minor Changes

- 966b65d: `workspace remove` no longer checks the remote (`--no-remote-check` is gone — the local branch is always kept) and now refuses on uncommitted changes unless `--force`. `workspace setup <branch> [-c]` runs from any worktree; with `-c`, the new branch starts at the current worktree's HEAD, or at any commit-ish via the new `--from <ref>` option.

## 0.17.0

### Minor Changes

- b027838: Remove `registryDir`. The registry is now derived as `${runtimeDir}/shared-registry`, auto-symlinked per linked worktree by `workspace setup`. To migrate an existing registry: `workspace migrate-0.16 <old-registryDir>`.

## 0.16.0

### Minor Changes

- 8724de4: Add `source` option to `configFiles` entries to override a config file's initial content.

### Patch Changes

- 5494483: Report a failing callback server's `start()` cleanly instead of as an unhandled stack trace.

## 0.15.1

### Patch Changes

- Fix the foreground log-follow offset to count raw bytes (a log with invalid UTF-8 no longer skews where following resumes), and guard `lastLines` against a non-positive count.

## 0.15.0

### Minor Changes

- `dev` (foreground): stream logs from the first byte so the whole startup is visible live, and attach to an already-running dev-server (replay recent log + follow; CTRL+C detaches) instead of refusing to start.

## 0.14.2

### Patch Changes

- Dedupe the dev-server spawn-and-rollback path and make foreground startup interruptible without double-teardown: a CTRL+C arriving while servers were still starting could roll back twice and exit with a nondeterministic code. The signal handler now owns teardown, and the in-flight failure defers to it.

## 0.14.1

### Patch Changes

- Foreground `dev` now exits on its own when its servers are stopped externally (`dev down`, `down --all`, eviction, or a manual kill) instead of hanging on dead servers and holding the terminal.

## 0.14.0

### Minor Changes

- b05c1fc: Add `dev status` (report UP/DOWN) and `dev restart` (stop then background-start) subcommands. Rename `workspace info` to `workspace status` (breaking).

## 0.13.0

### Minor Changes

- 31c3668: `dev` subcommands + foreground mode; `workspace list` DEV column

## 0.12.0

### Minor Changes

- Align user-facing vocabulary on "workspace" and tidy generated names.

## 0.11.1

### Patch Changes

- Improved the CLI help.

## 0.11.0

### Minor Changes

- 18f400e: Renamed to @paleo/workspace, single-verb setup CLI.

## 0.10.3

### Patch Changes

- Upgraded package metadata

## 0.10.2

### Patch Changes

- First version in changelog
