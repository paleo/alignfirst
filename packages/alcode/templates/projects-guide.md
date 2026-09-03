# `alcode projects` guide

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker contains an optional description and inclusive `portRange`. A directory without the marker is skipped as a projects directory. Nested markers may claim sub-ranges inside their nearest enclosing range.

A project is a direct child whose `alignfirst config --json` report finds a root or overlay project config. It either contains `.alignfirst.json` or is a Git main worktree matched by an AlignFirst overlay. Linked Git worktrees are listed as its workspaces. Other child directories appear under `others`.

## Commands

```sh
alcode projects list [--json] [--root <path>]
alcode projects status <path> [--json] [--root <path>]
alcode projects init [--root <path>] [--description <text>] [--port-range <first>-<last>]
alcode projects free-ports --size <n> [--json] [--root <path>]
alcode projects --guide [--root <path>]
```

`--root` selects the projects directory. It defaults to the working directory.

## Port claims

Run `alcode projects free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. Record the returned block as `portRange` in the project's `.alignfirst.json`. For a new project, pass it to `alignfirst setup --port-range <first>-<last>`.

The project config is its registration. Deleting the project removes it from the listing. The workspace kernel refuses a `workspace` command when the project's `portRange` disagrees with its port scheme.

## Reported issues

The listing reports invalid project configs, non-main root projects, project or nested-directory ranges outside their enclosing range, overlapping project ranges, and overlays that match no project under the selected root.
