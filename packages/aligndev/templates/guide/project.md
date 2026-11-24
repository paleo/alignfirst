# Projects guide

## The scan

The inventory scans a root directory: `--root`, else `projectsRoot` in the aligndev settings, else the working directory. Each child directory is one of these:

- A git main worktree is a project. The scan does not descend into it.
- A linked worktree is a workspace of its project, listed by directory name under the project's `workspaces`.
- Any other directory is a group, scanned in turn.

`--max-depth <n>` limits the descent through groups; the root's children are at depth 1, and a project at depth `n` is found. The default is 5. Hidden directories and `node_modules` are skipped silently.

## Skipped directories

`skippedDirectories` lists what the scan saw but did not inventory. An entry there is not a project. Its `reason` is one of:

- `outsideWorktree` — a linked worktree whose main worktree is outside the scan.
- `workFilesRepository` — a repository holding another project's `.plans`, such as a work-files clone.
- `symlink` — a symlinked directory, not followed.
- `unreadable` — permission denied.
- `maxDepth` — a group at the depth limit, not scanned.

## Port ranges

`portRange` in the aligndev settings is the machine's range for dev servers. Each project's range comes only from `devServer.ports` in its selected configuration.

`{{ALIGNDEV}} project free-ports --size <n>` returns the lowest block of `n` ports inside `portRange` that overlaps no project range of the scan. The size is the project's port names × its expected concurrent workspaces. This is a lookup, not a reservation: the setup guide writes the returned block in the project's `devServer.ports`.

## Commands

```sh
{{ALIGNDEV}} project list [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project doctor [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project status <path> [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project free-ports --size <n> [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} guide project
```

`doctor` is a read-only health gate. It succeeds only when the scan completes without any issue; skipped directories do not fail it.

## Companion locations

A project's AlignFirst files may live in its companion directory, the `dir` of its entry in the companion registry `~/.alignfirst/companions/registry.json`. `{{ALIGNDEV}} project status <path>` gives each location, including nullable `locations.assistantInstructionsFile`. Run `{{ALIGNFIRST}} assistant-instructions` from the selected worktree for its conventions and configured assistant guide.

## Reported issues

- An invalid project configuration.
- An `alignfirst.json` or `alignfirst.jsonc` in a directory outside a git main worktree. The scan still treats that directory as a group.
- A project range outside `portRange`.
- Two overlapping project ranges, anywhere in the scan.
- Two projects whose registry entries resolve to the same companion directory.
