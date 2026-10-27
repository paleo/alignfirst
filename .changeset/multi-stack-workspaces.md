---
"alignfirst": minor
"aligndev": minor
"@alignfirst/workspace": minor
---

Added language-neutral `alignfirst workspace` and `alignfirst dev` commands with `alignfirst.json`/`.jsonc` conventions and branch-local `alignfirst-workspace.json`/`.jsonc` recipes; removed `aligndev worktree`, JavaScript wrappers and legacy settings/runtime formats. Before upgrading existing worktrees, follow `docs/upgrading-multi-stack-workspaces.md` to account for services and resources and convert configuration and state together.
