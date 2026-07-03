---
"@paleo/workspace": minor
---

`workspace setup` now always **blocks** until the detached finalize reaches READY/FAILED (the removed `--wait` opt-in is the new default and only behavior).
