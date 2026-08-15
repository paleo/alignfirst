---
"@paleo/workspace": minor
---

Ports are now optional. The port scheme moves into a `ports` config group (`base`, `perWorkspace`, `maxWorkspaces`, and exactly one of `names`/`compute`); omit the group for portless mode. The registry becomes `workspaces.json`, keyed by the worktree directory name: callbacks receive `ctx.name` instead of `ctx.slot`, and `--slot` disappears from every command — select a workspace by its directory path or name. `devServerScript` and a spawn server's `port` are optional too. The `migrate-0.16` command is removed.

To upgrade: on the old version, run `workspace remove` for each linked worktree; upgrade the package and rewrite `workspace.mjs` / `dev-server.mjs` to the new config shape; delete the stale `slots.json`; re-create the workspaces with `workspace setup <branch>`.
