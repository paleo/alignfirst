---
"@paleo/openclaw-channel-mock-core": patch
---

The `read` and `search` actions now resolve every id shape the surfaces advertise — composite `thread:<conv>/<tid>` targets in `threadId`, thread-shaped `to`/`target`, the current-channel fallback when no destination is given (Discord), and a thread id in channel position. Slack-shaped `read` now requires a destination, like the real plugin.
