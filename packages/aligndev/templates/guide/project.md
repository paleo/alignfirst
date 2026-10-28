# Projects guide

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker contains an optional description and `portRanges`. Each range has `first`, `last`, and optional `code` and `description`. The entry without a code is the default; codes name the project kind a range serves. A directory without the marker is skipped as a projects directory. Nested markers may claim sub-ranges inside one nearest enclosing range.

A project is a git main worktree, direct child of a projects directory. Its linked worktrees are listed as its workspaces. Other child directories, those that are not git repositories, appear under `others`.

A project's AlignFirst files may live in its companion directory, the `dir` of its entry in the companion registry `~/.alignfirst/companions/registry.json`. `{{ALIGNDEV}} project status <path>` gives each location, including nullable `locations.developerInstructions`. Run `{{ALIGNFIRST}} developer-instructions` from the selected worktree for its conventions and configured developer guide.

## Commands

```sh
{{ALIGNDEV}} project list [--json] [--root <path>]
{{ALIGNDEV}} project doctor [--root <path>]
{{ALIGNDEV}} project status <path> [--json] [--root <path>]
{{ALIGNDEV}} project init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
{{ALIGNDEV}} project free-ports --size <n> [--range <code>] [--json] [--root <path>]
{{ALIGNDEV}} guide project [--root <path>]
```

`--root` selects the projects directory. It defaults to `projectsRoot` in the aligndev settings, then to the working directory.

`doctor` is a read-only health gate. It exits successfully only when discovery completes with no
inventory issues.

## Port claims

Run `{{ALIGNDEV}} project free-ports --size <n>` with the size of the project's port range: port names × expected concurrent workspaces. The directory section identifies the range for each project kind. Pass `--range <code>` for a coded range; the default needs no flag. This is a lookup, not a reservation. The setup guide writes the returned block in the selected merged configuration's `devServer.ports`.

Git main-worktree discovery identifies the project. The `alignfirst config --json` report supplies validated workspace metadata; project/companion conventions carry no duplicate port claim.

## Reported issues

The listing reports invalid project configs, non-main root projects, an `alignfirst.json` or `alignfirst.jsonc` outside a git main worktree, project or nested-directory ranges outside their enclosing range, overlapping project ranges, and projects whose registry entries resolve to the same companion directory.
