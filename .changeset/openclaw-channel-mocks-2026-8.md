---
"@paleo/openclaw-channel-mock-core": minor
"@paleo/openclaw-discord-mock": patch
"@paleo/openclaw-slack-mock": patch
---

OpenClaw 2026.8 compatibility. The core package now requires `zod` as a peer dependency (pinned to OpenClaw's version) and no longer provides the `messaging.parseExplicitTarget` handler.
