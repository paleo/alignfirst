---
"@paleo/openclaw-test": patch
---

env: pre-create the `.gateway-logs` output dir host-side (as the current user), like `artifacts/`. Previously a missing `.gateway-logs` was auto-created by the Docker daemon as `root`, leaving the gateway (running at the host UID) unable to write its logs and the user unable to delete the dir without `sudo`.
