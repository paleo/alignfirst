# @paleo/alproject

Discover local Git projects, track explicit registrations, and allocate non-overlapping port ranges.

## Installation

```sh
npm install --global @paleo/alproject
```

Create `~/.alproject.json` with the primary root, allowed project parents, and port limits.

## Commands

```text
alproject list [--json]
alproject register <path> [--ports-per-workspace <n> --max-workspaces <n>]
alproject unregister <path>
```

Run `alproject --guide` for configuration, discovery, status, allocation, and recovery procedures.
