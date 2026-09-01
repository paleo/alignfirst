---
"@paleo/openclaw-test": minor
---

OpenClaw 2026.8 support. `ctx.getAgentToolCalls()` is now async, each cell archives `transcripts.json` instead of a `trajectory/` directory, `waitForOutbound`'s CLI-silence fail-fast default grew from 30s to 60s, and model-selected runs reject the retired `agents.list` config shape — migrate to `agents.entries`.
