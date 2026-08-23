# alproject guide

`alproject` discovers local Git projects and maintains explicit registrations and optional port reservations.

## Configuration

Create `~/{{CONFIG_FILENAME}}` before running commands:

```json
{
  "root": "~/projects",
  "projectParents": ["~/projects", "~/work/projects"],
  "firstPort": 8000,
  "lastPort": 9999
}
```

`root` is the base for relative command paths and stores `alproject-registry.json`. `projectParents` lists the directories whose direct children may be discovered and registered. It defaults to `[root]`. All configured directories must exist. Alproject reads this configuration but never changes it.

## Discovery and statuses

Discovery inspects direct child directories only. A `.git` directory identifies a main worktree. A linked worktree is associated only when both sides of its Git metadata relationship are valid and its main worktree is under an allowed parent. Other child directories appear as additional directories.

`list` merges discovery with the registry and reports:

- `registered` — present on the filesystem and in the registry;
- `unregistered on filesystem` — discovered without a registry entry;
- `registered but missing from filesystem` — retained in the registry after a move or deletion.

Discrepancies are informational. Listing never changes files or registrations.

## Commands

### `alproject list`

Print every project with its name, main path, parent, status, workspace names, and optional port allocation. Additional directories are grouped by parent.

### `alproject register <path>`

Register an existing Git main worktree that is a direct child of an allowed parent. Relative paths resolve from `root`; absolute paths are accepted directly.

Use both port options to reserve a range:

```sh
alproject register <path> --ports-per-workspace <n> --max-workspaces <n>
```

Both values must be positive integers. `max-workspaces` includes the main worktree. Alproject reserves `ports-per-workspace * max-workspaces` ports and selects the lowest contiguous free block in the configured inclusive range. It considers registry reservations rather than listening processes.

To change a registration, unregister it first.

### `alproject unregister <path>`

Remove a registry entry and release its port reservation. A missing project path can still be unregistered. This command does not delete the main worktree, linked worktrees, or any other files.

### Global options

- `--guide` — print this guide and optional project-specific guidance;
- `-h`, `--help` — print concise command help;
- `-v`, `--version` — print the installed version.

A bare invocation prints help.

## Registry ownership and recovery

Alproject owns `<root>/alproject-registry.json` and its short-lived lock and temporary sibling files. Edit project files and immutable configuration through their own workflows.

Concurrent mutations wait briefly for a live lock and then fail with an actionable error. Retry after the other command finishes. Alproject reclaims locks whose recorded process no longer exists. If registry validation fails, correct the reported field or restore a valid registry before retrying. Failed registration, allocation, locking, and writes preserve the previous registry.

When `<root>/alproject-guide.md` exists, `alproject --guide` appends it verbatim after this generic guide. An unreadable custom guide is an error.
