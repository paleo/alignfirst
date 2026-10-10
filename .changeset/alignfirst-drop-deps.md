---
"alignfirst": minor
---

Dropped the `arktype` and `semver` dependencies. The `cli` field of `.alignfirst.json` now accepts full `x.y.z` versions with `^`, `~`, `>=`, `>`, `<=`, `<` or `=`, joined by spaces or `||`; other ranges are rejected.
