---
"@paleo/workspace": major
---

Ports are now optional. The port scheme moves into a `ports` config group (`base`, `perWorkspace`, `maxWorkspaces`, and exactly one of `names`/`compute`); omit the group for portless mode. The registry becomes `workspaces.json`, keyed by the worktree directory name: callbacks receive `ctx.name` instead of `ctx.slot`, and `--slot` disappears from every command — select a workspace by its directory path or name. `devServerScript` and a spawn server's `port` are optional too. The `migrate-0.16` command is removed.

To upgrade:

1. In the main worktree, upgrade the package and rewrite `workspace.mjs` / `dev-server.mjs` to the new config shape. Keep `ports.base` and `ports.perWorkspace` equal to the old `basePort` and `portStep`, so every workspace keeps its ports. Commit.
2. Run `workspace migrate` from the main worktree. It converts the registry in place — worktrees, their gitignored content and running dev-servers are preserved — and lists the branches to update.
3. In each linked worktree, merge the base branch and reinstall dependencies.

Until the migration runs, every command fails fast on the old registry. Contributors pulling the upgraded base branch start at step 2.
