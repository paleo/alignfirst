---
"@paleo/workspace": major
---

Ports are now optional. The port scheme moves into a `ports` config group (`base`, `perWorkspace`, `maxWorkspaces`, and exactly one of `names`/`compute`); omit the group for portless mode. The registry becomes `workspaces.json`, keyed by the worktree directory name: callbacks receive `ctx.name` instead of `ctx.slot`, and `--slot` disappears from every command — select a workspace by its directory path or name. `devServerScript` and a spawn server's `port` are optional too. The `migrate-0.16` command is removed.

To upgrade:

- List the workspaces. List also the active remote branches. Determine which branches have to be upgraded. Ask confirmation to the user before to proceed to the next step.
- Ensure the main worktree is on the base branch.
- Ensure every worktree has an empty `git status` first (commit your work).
- Run `workspace remove` for each linked worktree.
- In the main worktree, upgrade the package and rewrite `workspace.mjs` / `dev-server.mjs` to the new config shape. Commit.
- Propagate the change by merging the base branch back to the branches of the deleted workspaces
- Delete the stale `.local-wt/workspace-registry/slots.json`.
- Setup the main workspace with `workspace setup` on the main worktree.
- Re-create the linked workspaces with `workspace setup <branch>` from the main worktree.
