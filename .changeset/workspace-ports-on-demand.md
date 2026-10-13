---
"@alignfirst/workspace": minor
---

Breaking: ports and the files that carry them move to the dev-server config (`ports`, `runFiles`), and infrastructure moves to its `setup` hook, run by the new `dev setup` (also before every start; `--force` re-provisions, so the hook must stay idempotent). `workspace setup --full` also runs the dev setup. Setup profiles are removed: build public URLs from `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST` in run-file patches. Linked workspaces get new ports; `ports.mainWorktree` keeps the main worktree's.
