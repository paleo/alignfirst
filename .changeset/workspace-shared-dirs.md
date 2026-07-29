---
"@paleo/workspace": minor
---

`workspace setup` now creates a missing shared directory in the main worktree instead of skipping its symlink, so directories like `.local` exist before the first linked worktree needs them. A broken symlink at a shared directory's place in the main worktree is reported as an error.
