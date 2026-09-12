---
"alignfirst": minor
---

`alignfirst sync` now resolves successive rebase conflicts in the shared plans clone by keeping the local version for content conflicts and every present path for rename and delete conflicts. Automatic archival skips recent running alcode sessions while allowing stale sessions left by interrupted runs to archive.
