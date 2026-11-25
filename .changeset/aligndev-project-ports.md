---
"aligndev": minor
---

Breaking: `aligndev project free-ports` requires `--within <first>..<last>`, and the `portRange` setting is retired (ignored with a warning). Added `aligndev project ports` to print the claimed port ranges. Both commands report projects with an unreadable configuration as unknown ranges. Requires the matching `alignfirst` release.
