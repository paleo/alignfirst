# @paleo/alcode

## 0.2.0

### Minor Changes

- New `--meta "<text>"` flag: stores an opaque handoff string verbatim in the session file's `meta:` frontmatter, for a later reader of the file; `alcode` never interprets it.

## 0.1.0

### Minor Changes

- eb16d88: New `alcode` CLI: run a coding agent through AlignFirst protocols. It runs the coding agent in the foreground, streams a live transcript to both stdout and a per-run session file under `.plans/` (frontmatter status lifecycle + `Session ID`), and blocks until the run finishes. The caller backgrounds long runs; `alcode --guide` prints the delegation manual, and `alcode --openclaw-guide` prints the OpenClaw variant (`exec` with `background: true` + `timeout: 0`, completion-wake procedure). If terminated, alcode kills its coding-agent child so no orphan is left behind, and seals the session file with `status: failed` / `exitReason: terminated`.
