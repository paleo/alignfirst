---
"@paleo/workspace": minor
---

Added `--profile <name>` to `workspace setup`. A failure before the finalize step now marks the workspace `failed`; retry with a plain `setup` instead of `--force`.
