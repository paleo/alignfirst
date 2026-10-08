---
"@alignfirst/openclaw-channel-mock-core": minor
---

The Discord mock adopts a thread created on the turn's triggering message, as native Discord does: the turn's final reply lands in it, and a `thread-reply` there counts as the turn's reply and returns `{ ok: true, result: { messageId, channelId } }`. The Slack mock counts a threaded `send` rooted on the turn's message as the turn's reply.
