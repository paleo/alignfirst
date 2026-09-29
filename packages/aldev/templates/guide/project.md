# Projects guide

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker contains an optional description and `portRanges`. Each range has `first`, `last`, and optional `code` and `description`. The entry without a code is the default; codes name the project kind a range serves. A directory without the marker is skipped as a projects directory. Nested markers may claim sub-ranges inside one nearest enclosing range.

A project is a git main worktree, direct child of a projects directory. Its linked worktrees are listed as its workspaces. Other child directories, those that are not git repositories, appear under `others`.

A project's AlignFirst files may live in its companion directory, declared in `~/.config/alignfirst/companions.json`. `{{ALDEV}} project status <path>` gives each location.

## Commands

```sh
{{ALDEV}} project list [--json] [--root <path>]
{{ALDEV}} project doctor [--root <path>]
{{ALDEV}} project status <path> [--json] [--root <path>]
{{ALDEV}} project init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
{{ALDEV}} project free-ports --size <n> [--range <code>] [--json] [--root <path>]
{{ALDEV}} guide project [--root <path>]
```

`--root` selects the projects directory. It defaults to `projectsRoot` in the aldev config, then to the working directory.

`doctor` is a read-only health gate. It exits successfully only when discovery completes with no
inventory issues.

## Port claims

Run `{{ALDEV}} project free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. The directory section identifies the range for each project kind. Pass `--range <code>` for a coded range; the default needs no flag. The setup guide writes the returned block as `portRange` in the project's `.alignfirst.json`.

The project config is its registration. Deleting the project removes it from the listing. The workspace kernel refuses a `workspace` command when the project's `portRange` disagrees with its port scheme.

## Reported issues

The listing reports invalid project configs, non-main root projects, a `.alignfirst.json` outside a git main worktree, project or nested-directory ranges outside their enclosing range, overlapping project ranges, and projects sharing one companion directory.
