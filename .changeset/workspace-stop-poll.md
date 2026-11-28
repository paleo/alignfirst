---
"@alignfirst/workspace": patch
---

Stopping a dev-server process group polls its liveness every 100 ms instead of 300 ms, so stops return sooner.
