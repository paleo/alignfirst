---
"@paleo/workspace": patch
---

`wait --slot` and `status --slot` now accept the main worktree's reserved slot (its base port). Suggested commands in tips and errors are now prefixed for your package manager, and the `wait` tip after `setup` uses the worktree directory name — or no argument for the current worktree — instead of `--slot`.
