---
"@alignfirst/workspace": minor
---

Preserved hand edits to run files across restarts until ports or the new `runFilesInputs` change, with a warning when files are updated. Explicit `dev setup` still reconciles every file. Generated content now refreshes in entry order during rewrites. Failed write batches and main-directory renames trigger reconciliation at the next start.
