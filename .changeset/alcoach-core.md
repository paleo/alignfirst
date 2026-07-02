---
"@paleo/alcoach": minor
---

New `alcoach` CLI: coach a coding agent through AlignFirst protocols. It runs `claude` in the foreground, streams a live transcript to both stdout and a per-run log file under `.plans/` (frontmatter status lifecycle + `Session ID`), and blocks until the run finishes. To run long coaching sessions as background tasks, the caller backgrounds it — under OpenClaw, via the `exec` tool with `timeout: 0`, which auto-backgrounds it and wakes the same session on exit. If terminated, alcoach kills its `claude` child so no orphan is left behind.
