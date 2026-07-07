# @paleo/alcode

Run a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols from the terminal. `alcode` wraps a coding-agent CLI for non-interactive use: it invokes a protocol (`spec`, `plan`, `aad`, …), streams the run to a per-call session file under `.plans/`, and returns the result.

Run `alcode --guide` for the full delegation guide. When an OpenClaw agent is the caller, run `alcode --openclaw-guide` instead: the same manual, with the OpenClaw-specific run instructions (`exec` with `background: true` + `timeout: 0`, and the completion-wake procedure).

## Execution model

`alcode` runs the coding agent as a direct **foreground** child of its own process: it streams a live transcript to stdout and to a per-run session file (with a YAML frontmatter status lifecycle `running` → `succeeded`/`failed`), and blocks until the agent exits. It never backgrounds or detaches itself.

Coding runs can be very long: the caller always runs `alcode` as a background task and owns the backgrounding. Under OpenClaw the agent invokes `alcode` through the `exec` tool with `background: true` and `timeout: 0`, chaining `openclaw system event --mode now --session-key <key>` onto the command as prescribed by the guide; that immediate wake fires when the run finishes, and the woken agent reads the session file for the result. This keeps the run's lifecycle owned by one supervisor (the caller) instead of a detached process phoning back in. The session file is the durable result handoff: frontmatter `sessionId` + status, and the `---- Result ----` block.

If `alcode` is terminated, its signal handlers seal the session file (`status: failed`, `exitReason: terminated`) so it never stays frozen at `running`, then send `SIGTERM` to the coding-agent child, giving it a short grace to tear down its own subprocesses before a `SIGKILL` backstop guarantees no orphan is left behind. Only a `SIGKILL` of `alcode` itself (uncatchable) can leave a stale `running` status.

## Usage

```bash
alcode --new --protocol spec --ticket AB-123 --message "Feature description"
alcode --resume <sessionId> --protocol plan
alcode --new --message "Execute the plan: .plans/AB-123/A2-plan.md"
```

See `alcode --help` for all flags and environment variables.
