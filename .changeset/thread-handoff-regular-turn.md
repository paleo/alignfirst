---
"@paleo/alignfirst-developer-openclaw-plugin": minor
---

Thread sessions now start with a static "Take over this thread." message from AlignFirst Service. Repeated claims by the same run return `claimed`. `openclaw thread-handoff list` exposes attempt counts and claimer identity. Databases from 0.2.0 migrate automatically and cannot be downgraded without deletion.
