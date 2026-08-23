---
"@paleo/openclaw-test": patch
---

Fixed two false-failure sources: `waitForOutbound`'s CLI-mock grace fail-fast now arms only on CLI calls made during the wait, disarms on any observed outbound, and defaults to 30s; trajectory parsing now falls back to a session's newest usable snapshot when its latest event is byte-capped, instead of dropping the session's tool calls.
