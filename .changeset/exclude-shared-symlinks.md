---
"@paleo/workspace": patch
---

`workspace setup` now writes the shared-directory symlinks it creates into the linked worktree's `info/exclude`, so a fresh worktree no longer reads as dirty (and `workspace remove` no longer refuses it) when the repository's gitignore uses directory-shaped patterns like `.plans/`.
