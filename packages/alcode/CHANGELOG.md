# @paleo/alcode

## 0.4.0

### Minor Changes

- 53fc35d: Session files moved from `coding-sessions/` to `_alcode/` (`.plans/<ticket>/_alcode/` or `.plans/_alcode/`; the old directories are no longer read). alcode now fails fast on `--resume` with an unknown session id, on resuming a session that is still running, and on launching a protocol run while another run is active in the same worktree.

### Patch Changes

- 85e13a3: The `--openclaw-guide` completion-wake procedure now ends the wake turn with `NO_REPLY` once the report is routed via the `message` tool, preventing stray duplicates on the session's default surface.

## 0.3.0

### Minor Changes

- Add a `-v`/`--version` flag that prints the alcode version.

## 0.2.0

### Minor Changes

- New `--meta "<text>"` flag: stores an opaque handoff string verbatim in the session file's `meta:` frontmatter, for a later reader of the file; `alcode` never interprets it.

## 0.1.0

### Minor Changes

- eb16d88: New `alcode` CLI: run a coding agent through AlignFirst protocols. It runs the coding agent in the foreground, streams a live transcript to both stdout and a per-run session file under `.plans/` (frontmatter status lifecycle + `Session ID`), and blocks until the run finishes. The caller backgrounds long runs; `alcode --guide` prints the delegation manual, and `alcode --openclaw-guide` prints the OpenClaw variant (`exec` with `background: true` + `timeout: 0`, completion-wake procedure). If terminated, alcode kills its coding-agent child so no orphan is left behind, and seals the session file with `status: failed` / `exitReason: terminated`.
