---
"@paleo/openclaw-channel-mock-core": minor
---

Thread renaming, matching real Discord: `thread-create` now reads the thread name from `threadName`, and a `send` / `thread-reply` carrying `threadName` renames the target thread.
