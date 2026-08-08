# @paleo/alcode

## 0.9.0

### Minor Changes

- 29bcdc5: The `--model` flag now takes a bare model name from a fixed list: `fable`, `opus`, `sonnet`, `haiku`. Set `ALIGNFIRST_CODE_MODELS` (comma-list) to replace the list, e.g. on a host whose plan lacks some tiers.

## 0.8.1

### Patch Changes

- 5e9e354: The AAD workflow now states its commit step explicitly: commit with the summary file's suggested message.

## 0.8.0

### Minor Changes

- 1470b76: The delegation guide now asks the agent to verify a completed run — project checks plus a hands-on look — and to end the wake turn on one consolidated report, rather than relaying the session file alone; spec → plan → execute runs without stopping for the user to approve the plan.

## 0.7.0

### Minor Changes

- ff4d909: Documented the review workflow in the CLI reference: a fresh `review` session, then an optional fix step in a fresh AAD session on the review file.

## 0.6.0

### Minor Changes

- Detect when the coding agent's session is lost or expired: alcode now seals the session file with `exitReason: auth_required`, exits `2`, and prints a clear message telling an administrator to re-login on the host.

## 0.5.3

### Patch Changes

- 537c8f5: Recommend allowing commits between sub-plans when executing a main plan (CLI reference template)
- c8f0083: The OpenClaw guide's "started" ack now follows the completion-report delivery rule: plain text on a thread-bound session, `message` `thread-reply` only for a thread created this turn (`--meta`) — fixes doubled replies in Discord threads.

## 0.5.2

### Patch Changes

- The OpenClaw guide now marks the "started" background-run ack as a Discord `message` `thread-reply`, so it lands in the work thread instead of streaming to the parent channel.

## 0.5.1

### Patch Changes

- The OpenClaw guide now omits `--meta` on Slack (the completion report is a plain-text reply, since Slack exposes no `send`/`thread-reply` action) and reserves it for a Discord thread you created yourself, and it no longer emits `HEARTBEAT_OK` (a wake with nothing to report ends with `NO_REPLY`).

## 0.5.0

### Minor Changes

- bc41c8e: Resumed and plan-execution runs now inherit or infer their ticket, so session files land in `.plans/<ticket>/_alcode/`. The OpenClaw guide prescribes a chained `openclaw system event` completion wake and English delegation messages.

  `--guide` is now minimal, free of OpenClaw-specific run and wake machinery.

## 0.4.1

### Patch Changes

- The session guide now tells the agent to start a new session after one turns bad, rather than reusing it.

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
