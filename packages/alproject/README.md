# @alignfirst/alproject

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker holds an optional description and port ranges. A direct child with a root `.alignfirst.json` is a project; linked Git worktrees are listed as its workspaces.

```json
{
  "description": "Every project is a direct child of ~/projects.",
  "portRanges": [
    { "first": 28000, "last": 28599, "description": "Web projects, exposed through the gateway." },
    { "code": "local", "first": 29000, "last": 29199, "description": "Desktop apps, never exposed." }
  ]
}
```

When upgrading from v2, replace the marker's `"portRange": { ... }` with `"portRanges": [{ ... }]`. The old marker key is rejected. Project configuration in `.alignfirst.json` keeps its singular `portRange` key.

Prerequisite: install the `alignfirst` CLI on `PATH` with `npm install -g alignfirst`.

Install `alproject` with `npm install -g @alignfirst/alproject`.

## Commands

```sh
alproject list [--json] [--root <path>]
alproject doctor [--root <path>]
alproject status <path> [--json] [--root <path>]
alproject init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
alproject free-ports --size <n> [--range <code>] [--json] [--root <path>]
alproject --guide [--root <path>]
```

## Port claims

Run `alproject free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. A marker entry without a code is the default range. Pass `--range <code>` to select a coded range. The setup guide writes the returned block as `portRange` in the project's `.alignfirst.json`.
