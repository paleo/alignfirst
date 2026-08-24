# @paleo/alproject

Discover local Git projects, track explicit registrations, and allocate non-overlapping port ranges.

## Installation

```sh
npm install --global @paleo/alproject
```

## Configuration

Create `~/.alproject.json` before running commands:

```json
{
  "root": {
    "path": "~/projects",
    "portRange": {
      "first": 8000,
      "last": 9999
    }
  },
  "projectParents": [
    {
      "path": "~/projects"
    },
    {
      "path": "~/work/projects",
      "portRange": {
        "first": 9000,
        "last": 9999
      }
    }
  ]
}
```

`root.path` is the base for relative command paths and stores `alproject-registry.json`. `root.portRange` is the inclusive global allocation range. `projectParents` lists the directories whose direct children may be discovered and registered. It defaults to the root path. All configured directories must exist.

An optional parent `portRange` reserves part of the global range for projects under that parent. Parent ranges must be inside the global range and cannot overlap. Projects under parents without a dedicated range share the unreserved ports.

## Commands

```text
alproject list [--json]
alproject status <path> [--json]
alproject register <path> [--ports-per-workspace <n> --max-workspaces <n> [--base-port <n>]]
alproject unregister <path>
```

`status` reports one discovered or registered project. It includes the canonical main path, registration and filesystem status, optional port allocation, preferred remote host, and every Git worktree with its path and branch. Relative paths resolve from `root`; absolute paths are accepted directly. Pass the main-worktree path.

Run `alproject --guide` for the agent-facing operating guide. When `<root>/alproject-guide.md` exists, the command appends it verbatim after the generic guide — use it to describe how the project parents are organized. An unreadable custom guide is an error.

## Discovery and statuses

Discovery inspects direct child directories only. A `.git` directory identifies a main worktree. A linked worktree is associated only when both sides of its Git metadata relationship are valid and its main worktree is under an allowed parent. Other child directories appear as additional directories.

`list` merges discovery with the registry and reports:

- `registered` — present on the filesystem and in the registry;
- `unregistered on filesystem` — discovered without a registry entry;
- `registered but missing from filesystem` — retained in the registry after a move or deletion.

Discrepancies are informational. Listing never changes files or registrations.

## Registry ownership and recovery

Alproject owns `<root>/alproject-registry.json` and its short-lived lock and temporary sibling files. Edit project files and immutable configuration through their own workflows.

Concurrent mutations wait briefly for a live lock and then fail with an actionable error. Retry after the other command finishes. Alproject reclaims locks whose recorded process identity no longer exists. If registry validation fails, correct the reported field or restore a valid registry before retrying. Failed registration, allocation, locking, and writes preserve the previous registry.
