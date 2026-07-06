---
"@paleo/openclaw-channel-mock-core": minor
---

Thread inbounds now activate sessions keyed exactly like the real channels (Discord: the thread's own id as a channel peer; Slack: the `:thread:<ts>` suffix on the channel session key), and bus thread ids are prefixed with their conversation id.
