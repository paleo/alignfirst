# @paleo/alproject

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker holds an optional description and inclusive port range. A direct child with a root `.alignfirst.json` is a project; linked Git worktrees are listed as its workspaces.

Prerequisite: install the `alignfirst` CLI on `PATH` with `npm install -g alignfirst`.

Install `alproject` with `npm install -g @paleo/alproject`.

## Commands

```sh
alproject list [--json] [--root <path>]
alproject doctor [--root <path>]
alproject status <path> [--json] [--root <path>]
alproject init [--root <path>] [--description <text>] [--port-range <first>-<last>]
alproject free-ports --size <n> [--json] [--root <path>]
alproject --guide [--root <path>]
```

## Port claims

Run `alproject free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. The setup guide writes the returned block as `portRange` in the project's `.alignfirst.json`.
