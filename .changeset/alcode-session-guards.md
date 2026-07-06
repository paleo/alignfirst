---
"@paleo/alcode": minor
---

Session files moved from `coding-sessions/` to `_alcode/` (`.plans/<ticket>/_alcode/` or `.plans/_alcode/`; the old directories are no longer read). alcode now fails fast on `--resume` with an unknown session id, on resuming a session that is still running, and on launching a protocol run while another run is active in the same worktree.
