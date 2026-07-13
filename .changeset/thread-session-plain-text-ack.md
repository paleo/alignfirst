---
"@paleo/alcode": patch
---

The OpenClaw guide's "started" ack now follows the completion-report delivery rule: plain text on a thread-bound session, `message` `thread-reply` only for a thread created this turn (`--meta`) — fixes doubled replies in Discord threads.
