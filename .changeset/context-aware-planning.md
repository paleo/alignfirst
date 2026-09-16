---
"@paleo/alcode": minor
---

Renamed `alcode usage` to `alcode quota`, and added the run's context-window occupancy as `contextTokens` in the session file and in `alcode status`, beside `contextCompacted`. For Codex the figure comes from the thread's rollout file, since `codex exec --json` reports only cumulative session totals. `alcode status` gains `--meta <key>` to select a run by the key it was tagged with. The delegation guide uses the occupancy to decide whether the plan protocol continues in the spec's session or starts in a fresh one from a self-sufficient spec.
