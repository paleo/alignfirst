# @paleo/alcoach

Coach a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols from the terminal. `alcoach` wraps the `claude` CLI for non-interactive use: it invokes a protocol (`spec`, `plan`, `aad`, …), streams the run to a per-call log file under `.plans/`, and returns the result.

Run `alcoach --guide` for the full coaching guide.

## Execution model

Every run spawns `claude` as a detached background process that streams a live transcript into a log file with a YAML frontmatter status lifecycle (`running` → `succeeded`/`failed`).

- **Foreground** (a human or another coding agent): tails the transcript and blocks until the run finishes, then prints the result. This is the default.
- **Background** (OpenClaw): selected when a callback URL is resolvable (`ALIGNFIRST_COACH_CALLBACK_URL` or `--callback-url`). The command returns immediately, and on completion calls OpenClaw back in the exact thread session (`--session-key`) via `POST <url>` so it resumes the workflow.

## Usage

```bash
alcoach --new --protocol spec --ticket AB-123 --message "Feature description"
alcoach --resume <sessionId> --protocol plan
alcoach --new --message "Execute the plan: .plans/AB-123/A2-plan.md"
```

See `alcoach --help` for all flags and environment variables.
