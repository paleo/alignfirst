---
"@alignfirst/workspace": minor
---

`workspace setup` now re-applies the `patch` of an existing gitignored file without `--force`, rewrites the file only when the result differs, and reports the rewritten files on stdout (`Updated <paths>`). It refuses a `patch` that is not idempotent; entries without `patch` keep skipping existing files.
