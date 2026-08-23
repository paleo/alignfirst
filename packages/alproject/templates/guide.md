# alproject guide

Your project registry.

## Commands

### `alproject list [--json]`

Print every project with its name, main path, parent, status, workspace names, and optional port allocation. Additional directories are grouped by parent.

Pass `--json` for structured output consumed by tools and agents. The labelled output quotes every filesystem-derived value so control characters cannot create false fields.

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

- `--guide` — print this guide, followed by `<root>/alproject-guide.md` when it exists;
- `-h`, `--help` — print concise command help;
- `-v`, `--version` — print the installed version.
