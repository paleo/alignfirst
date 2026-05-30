# @paleo/worktree-env

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
