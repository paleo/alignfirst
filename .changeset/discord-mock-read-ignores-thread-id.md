---
"@alignfirst/openclaw-channel-mock-core": patch
---

Made the Discord surface's `read` ignore `threadId`, as native Discord does: a stray id no longer empties the history of the target thread.
