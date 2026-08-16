---
"@paleo/workspace": minor
---

Breaking: new config shape and names in the wrapper scripts, and ports are now optional. To upgrade: rewrite `workspace.mjs` / `dev-server.mjs` (keep the old `portStep` value as `ports.perWorkspace`), run `workspace migrate-registry-0.30` from the main worktree — existing workspaces are preserved — then merge the base branch in each linked worktree.

Prompt for your agent, with the `alignfirst-setup-guide` skill installed (`npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide`):

> Use the *alignfirst-setup-guide* skill. Rewrite our workspace wrapper scripts (`workspace.mjs` / `dev-server.mjs`) to the new `@paleo/workspace` config shape, keeping the old `basePort` as `ports.base` and the old `portStep` as `ports.perWorkspace` so every workspace keeps its ports. Then run `workspace migrate-registry-0.30` from the main worktree.
