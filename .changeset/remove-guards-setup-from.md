---
"@paleo/workspace": minor
---

`workspace remove` no longer checks the remote (`--no-remote-check` is gone — the local branch is always kept) and now refuses on uncommitted changes unless `--force`. `workspace setup <branch> [-c]` runs from any worktree; with `-c`, the new branch starts at the current worktree's HEAD, or at any commit-ish via the new `--from <ref>` option.
