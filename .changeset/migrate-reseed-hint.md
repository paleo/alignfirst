---
"@paleo/workspace": patch
---

`migrate-registry-0.30` now tells you to run `workspace setup --force` in each surviving worktree: its gitignored config still carries the old slot-derived infrastructure names, and merging the base branch does not regenerate it.
