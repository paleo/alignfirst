---
"@paleo/openclaw-test": minor
---

Adapted agent-activity tracking to OpenClaw 2026.8: the runner now reads tool calls and cost from the gateway's SQLite session transcripts through the exec-watcher RPC (the file-based trajectory log is gone upstream, and the SQLite trajectory events are too truncated to parse). Each cell archives its raw transcripts as `transcripts.json` instead of a `trajectory/` directory, `ctx.getAgentToolCalls()` is now async, and `waitForOutbound`'s CLI-silence fail-fast default grew from 30s to 60s.
