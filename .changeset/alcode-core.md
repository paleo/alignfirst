---
"@paleo/alcode": minor
---

New `alcode` CLI: run a coding agent through AlignFirst protocols. It runs `claude` in the foreground, streams a live transcript to both stdout and a per-run session file under `.plans/` (frontmatter status lifecycle + `Session ID`), and blocks until the run finishes. To run long sessions as background tasks, the caller backgrounds it — under OpenClaw, via the `exec` tool with `timeout: 0`, which auto-backgrounds it and wakes the same session on exit. If terminated, alcode kills its `claude` child so no orphan is left behind, and seals the session file with `status: failed` / `exitReason: terminated`.
