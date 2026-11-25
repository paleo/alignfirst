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

Each project's range comes only from `devServer.ports` in the selected configuration of its main worktree. A range declared in a linked worktree counts once it reaches the main worktree.

`{{ALIGNDEV}} project ports` prints the claimed ranges, sorted by first port, with paths relative to the scan root.

`{{ALIGNDEV}} project free-ports --size <n> --within <first>..<last>` returns the lowest block of `n` ports inside the bounds that overlaps no project range of the scan. The size is the project's port names × its expected concurrent workspaces. The bounds come from your context: the deployment's or the team's instructions. This is a lookup, not a reservation: the setup guide writes the returned block in the project's `devServer.ports`.

A project whose configuration report fails has an unknown range. Both commands still answer: the text form warns on stderr, and the JSON form lists these projects under `unknown`. Run `{{ALIGNDEV}} project doctor` to see why.

## Commands

```sh
{{ALIGNDEV}} project list [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project doctor [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project status <path> [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project ports [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} project free-ports --size <n> --within <first>..<last> [--json] [--root <path>] [--max-depth <n>]
{{ALIGNDEV}} guide project
```

`doctor` is a read-only health gate. It succeeds only when the scan completes without any issue; skipped directories do not fail it.

## Companion locations

A project's AlignFirst files may live in its companion directory, the `dir` of its entry in the companion registry `~/.alignfirst/companions/registry.json`. `{{ALIGNDEV}} project status <path>` gives each location, including nullable `locations.assistantInstructionsFile`. Run `{{ALIGNFIRST}} assistant-instructions` from the selected worktree for its conventions and configured assistant guide.

## Reported issues

- An invalid project configuration.
- An `alignfirst.json` or `alignfirst.jsonc` in a directory outside a git main worktree. The scan still treats that directory as a group.
- Two overlapping project ranges, anywhere in the scan.
- Two projects whose registry entries resolve to the same companion directory.
