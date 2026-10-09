---
"@alignfirst/workspace": minor
---

`workspace setup` now re-applies the `patch` of an existing gitignored file without `--force`, and rewrites the file only when the result differs (`Updated <path>`). A `patch` must be idempotent; entries without `patch` keep skipping existing files.
