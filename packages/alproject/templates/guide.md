# alproject guide

Your project registry.

## Configuration

```json
{
  "root": {
    "path": "~/projects",
    "portRange": { "first": 8000, "last": 9999 }
  },
  "projectParents": [
    { "path": "~/projects" },
    {
      "path": "~/work/projects",
      "portRange": { "first": 9000, "last": 9999 }
    }
  ]
}
```

`root.path` stores the registry and resolves relative command paths. `root.portRange` defines the inclusive global port range. `projectParents` defaults to the root path.

An optional parent `portRange` reserves part of the global range for that parent's projects. Parent ranges must be inside the global range and cannot overlap. Parents without a dedicated range share the remaining global ports.

## Commands

### `alproject list [--json]`

Print every project with its name, main path, parent, status, workspace names, and optional port allocation. Additional directories are grouped by parent.

Pass `--json` for structured output consumed by tools and agents. The labelled output quotes every filesystem-derived value so control characters cannot create false fields.

### `alproject status <path> [--json]`

Print one discovered or registered project with its canonical main path, status, port allocation, remote host, and Git worktrees. Each worktree includes its name, path, and branch. Missing optional values are explicit.

Relative paths resolve from `root`; absolute paths are accepted directly. Pass the main-worktree path. Linked-worktree paths and paths that are neither discovered nor registered produce an actionable error.

Pass `--json` for structured output. Absent port allocations, remote hosts, and detached-worktree branches are `null`.

### `alproject register <path>`

Register an existing Git main worktree that is a direct child of an allowed parent. Relative paths resolve from `root`; absolute paths are accepted directly.

Use both port options to reserve a range:

```sh
alproject register <path> --ports-per-workspace <n> --max-workspaces <n> [--base-port <n>]
```

The sizing values must be positive integers. `max-workspaces` includes the main worktree. Alproject reserves `ports-per-workspace * max-workspaces` ports and selects the lowest contiguous free block available to the project's parent. It considers registry reservations rather than listening processes.

Pass `--base-port` to claim an exact range instead. Registration fails when the claimed range is outside the ports available to the project's parent or overlaps an existing reservation.

To change a registration, unregister it first.

### `alproject unregister <path>`

Remove a registry entry and release its port reservation. A missing project path can still be unregistered. This command does not delete the main worktree, linked worktrees, or any other files.

### Global options

- `--guide` — print this guide, followed by `<root>/alproject-guide.md` when it exists;
- `-h`, `--help` — print concise command help;
- `-v`, `--version` — print the installed version.
