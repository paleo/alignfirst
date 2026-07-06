---
"@paleo/openclaw-channel-mock-core": patch
---

Inbound dispatch is now fire-and-forget with per-message error containment, like the real channel monitors — a long agent turn no longer delays the next inbound, and a failed dispatch no longer kills the account's poll loop. Gateway logs gain one `inbound dispatch start/done` line per inbound.
