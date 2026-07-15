# AlignFirst Delegation Guide

{{INTRODUCTION}}

## How it runs

`alcode` runs the coding agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout and to a session file under `.plans/`. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): background `alcode` with your platform's own background-execution facility — never detach it with `&` or a detach wrapper. **One protocol run at a time per worktree**; plain messages can be sent at any time.

Running under OpenClaw? Read `alcode --openclaw-guide` instead — the same manual with the OpenClaw-specific run and wake instructions.

## After a run completes

Read the run's session file (the path `alcode` prints on its first line, under `_alcode/`): its frontmatter carries `status` (`succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome. Report it to the user where the work was requested. If the run failed, say so plainly and propose the next step.

An `exitReason` of `auth_required` in the frontmatter (alcode also exits `2`) means the coding agent is not authenticated on the host: an administrator must re-login there before any run can succeed. Report that and do not retry.

Do **not** re-verify the repo, re-run the agent, or inspect `git` — the session file is authoritative. Keep session files in place; they are the durable audit trail.

{{CLI_REFERENCE}}
