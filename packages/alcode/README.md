# @paleo/alcode

Run a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols from the terminal. `alcode` wraps a coding-agent CLI for non-interactive use: it invokes a protocol (`spec`, `plan`, `aad`, …), streams the run to a per-call session file under `.plans/`, and returns the result.

Prerequisite: install the `alignfirst` CLI on `PATH` with `npm install -g alignfirst`.

Run `alcode --guide` for the full delegation guide. When an OpenClaw agent is the caller, run `alcode --openclaw-guide` instead: the same manual, with the OpenClaw-specific run instructions (`exec` with `background: true` + `timeout: 0`, and the completion-wake procedure).

## Execution model

`alcode` runs the coding agent as a direct **foreground** child of its own process: it streams a live transcript to stdout and to a per-run session file (with a YAML frontmatter status lifecycle `running` → `succeeded`/`failed`), and blocks until the agent exits. It never backgrounds or detaches itself.

Coding runs can be very long: the caller always runs `alcode` as a background task and owns the backgrounding. Under OpenClaw the agent invokes `alcode` through the `exec` tool with `background: true` and `timeout: 0`, chaining `openclaw system event --mode now --session-key <key>` onto the command as prescribed by the guide; that immediate wake fires when the run finishes, and the woken agent reads the session file for the result. This keeps the run's lifecycle owned by one supervisor (the caller) instead of a detached process phoning back in. The session file is the durable result handoff: frontmatter `sessionId` + status, and the `---- Result ----` block.

If `alcode` is terminated, its signal handlers seal the session file (`status: failed`, `exitReason: terminated`) so it never stays frozen at `running`, then send `SIGTERM` to the coding-agent child, giving it a short grace to tear down its own subprocesses before a `SIGKILL` backstop guarantees no orphan is left behind. Only a `SIGKILL` of `alcode` itself (uncatchable) can leave a stale `running` status.

When the coding agent's own session on the host is missing or expired, `alcode` detects the `authentication_failed` signal in its stream, seals the session file with `exitReason: auth_required`, and exits `2` (distinct from `1`) with a one-line stderr message.

## Usage

```bash
export ALIGNFIRST_CODE_AGENT=claude # or codex

alcode new --protocol spec --ticket AB-123 --message "Feature description"
alcode resume <sessionId> --protocol plan
alcode new --message "Execute the plan: .plans/AB-123/A2-plan.md"
alcode new --protocol aad --no-ticket --message "Task description"
alcode status .plans/AB-123/_alcode/20260829-135529.md
alcode usage
alcode projects list --root ~/projects
```

See `alcode --help` for all commands and options.

Run `alcode projects --guide` before project lifecycle work.

A new protocol session needs a ticket. `--no-ticket` makes `alcode` reserve the next side ticket through `alignfirst ticket --side` and pass it to the agent.

`alcode status <session-file>` reconciles and shows a run's durable status. If a recorded process is gone, the command seals the session file as `status: failed`, `exitReason: terminated`. New Linux records also store the process start time to detect pid reuse. The command accepts session files under the current project's `.plans/**/_alcode/` tree and does not start a coding agent.

`alcode usage` shows the selected coding agent's current account limits, consumed percentages, and reset times. It works outside a project and does not start a coding session.

## Coding agents

`ALIGNFIRST_CODE_AGENT` is required and accepts `claude` or `codex`. Install the selected CLI and authenticate it on the host: run `claude`, then `/login`, for Claude Code; run `codex login` for Codex.

Normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`. `ALIGNFIRST_CODE_SKIP_PERMISSIONS=1` selects each CLI's dangerous permission-bypass flag.

Claude's default model list is `fable,opus,sonnet,haiku`. Codex's is `sol,terra,luna`; alcode resolves a selected Codex alias against `codex debug models --bundled`. Set `ALIGNFIRST_CODE_MODELS` to narrow the selected agent's list or to advertise an explicit Codex slug such as `gpt-5.6-terra`.

New session files record `agent`. A session can only be resumed with the same selected agent. Agentless legacy sessions remain readable but require a new session.

## Environment variables

- `ALIGNFIRST_CODE_AGENT` — required coding agent: `claude` or `codex`.
- `ALIGNFIRST_CODE_MODELS` — comma-separated list replacing the selected agent's accepted models.
- `ALIGNFIRST_CODE_SKIP_PERMISSIONS` — `1` to run the coding agent with permission prompts disabled.
- `ALIGNFIRST_CODE_UNSET` — comma-separated list of extra env vars to strip from the coding-agent child.

Every `ALIGNFIRST_CODE_*` variable is stripped from the child's environment, so wrapper configuration never leaks into the coding agent.
