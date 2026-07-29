---
"@paleo/plans-repo": minor
---

New `plans-repo check` command: verifies that `.plans` is linked to a team plans repository, and exits 1 with guidance otherwise. For automation — e.g. the workspace `preSetup` callback — so a missing link fails the environment bootstrap instead of being discovered later.
