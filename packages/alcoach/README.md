# @paleo/alcoach

Coach a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols from the terminal. `alcoach` wraps the `claude` CLI for non-interactive use: it invokes a protocol (`spec`, `plan`, `aad`, …), streams the run to a per-call log file under `.plans/`, and returns the result.

Run `alcoach --guide` for the full coaching guide.

## Execution model

`alcoach` runs `claude` as a direct **foreground** child of its own process: it streams a live transcript to stdout and to a per-run log file (with a YAML frontmatter status lifecycle `running` → `succeeded`/`failed`), and blocks until `claude` exits. It never backgrounds or detaches itself.

To run it as a background task, the caller does the backgrounding. Under OpenClaw the agent invokes `alcoach` through the `exec` tool with `timeout: 0` — OpenClaw auto-backgrounds it and wakes the agent on exit (via `tools.exec.notifyOnExit`), which then reads the log for the result. This keeps the run's lifecycle owned by one supervisor (the caller) instead of a detached process phoning back in. The log is the durable result handoff: frontmatter `sessionId` + status, and the `---- Result ----` block.

If `alcoach` is terminated, it kills its `claude` child (signal handlers + process-group membership), so no orphaned `claude` is left behind.

## Usage

```bash
alcoach --new --protocol spec --ticket AB-123 --message "Feature description"
alcoach --resume <sessionId> --protocol plan
alcoach --new --message "Execute the plan: .plans/AB-123/A2-plan.md"
```

See `alcoach --help` for all flags and environment variables.
