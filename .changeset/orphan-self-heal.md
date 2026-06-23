---
"@paleo/workspace": minor
---

Self-heal orphaned workspaces (worktree deleted out-of-band). New `workspace prune` stops their dev-servers, drops the registry entries, and runs `git worktree prune`. `workspace list` auto-prunes the safe case; `workspace remove` now cleans up an already-deleted worktree too.
