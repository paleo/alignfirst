---
"@paleo/workspace": minor
---

`workspace setup` now always **blocks** until the detached finalize reaches READY/FAILED (the removed `--wait` opt-in is the new default and only behavior). Interrupting it is safe: finalize keeps running, `workspace wait` re-attaches. Callers that want the whole setup in the background must background the command themselves (e.g. OpenClaw's `exec` tool with `timeout: 0`).
