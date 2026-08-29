# AlignFirst Delegation Guide

{{INTRODUCTION}}

## How it runs

`alcode` runs the coding agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout and to a session file under `.plans/`. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): background `alcode` with your platform's own background-execution facility — never detach it with `&` or a detach wrapper. **One protocol run at a time per worktree**; plain messages can be sent at any time.

Running under OpenClaw? Read `alcode --openclaw-guide` instead — the same manual with the OpenClaw-specific run and wake instructions.

## After a run completes

Run `alcode status <session-file>` with the path printed on the run's first line. This reconciles a stale `running` record before reporting its status. Then read the session file: its frontmatter carries `status` (`succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome. Report it to the user where the work was requested. If the run failed, say so plainly and propose the next step.

An `exitReason` of `auth_required` in the frontmatter (alcode also exits `2`) means the coding agent is not authenticated on the host. An administrator must authenticate with {{AUTH_COMMAND}} before another run.

Don't reconstruct what happened: no re-running the agent, no `git` archaeology to double-check its account — the session file is authoritative for that. Do verify that the result works, though. Run the project's checks (tests, lint, build) and exercise the change yourself before calling it done; a failing check reopens the work in a new session.

Keep session files in place; they are the durable audit trail.

{{CLI_REFERENCE}}
