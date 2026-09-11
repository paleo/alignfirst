# AlignFirst Delegation Guide (OpenClaw)

{{INTRODUCTION}}

## How it runs

`alcode` runs the coding agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): **always run `alcode` as a background task**, so you stay free while it works. The backgrounding is **your platform's** job, never alcode's own.

Under OpenClaw, background it through the `exec` tool:

- Before the first `alcode` run of this session, call the `session_status` tool and read the `Session:` line from its result — that is this session's key. Obtain it once, reuse it for every run of this session.
- The exec command chains a completion wake onto the run:

  `alcode <command> <options> ; openclaw agent --session-key <KEY> --deliver --timeout 0 --message "alcode run finished — read its session file and report to the user"`

  Chain with `;` (never `&&`) so a failed run wakes you too, and keep the `;` on the same line as the `alcode` command: a line that starts with `;` is a shell syntax error, the wake command never runs, and the run's completion is lost. The wake arrives as that message in this session. `--timeout 0` gives the wake turn no time limit.
- Pass `background: true` and `timeoutSeconds: 0` (no kill timer). Never rely on the auto-yield or a finite timeout.
- Set the exec `workdir` to the project root as an **absolute** path (`~` is not expanded there), or `cd` into the project inside the command itself.
- The acknowledgement's "Use process (list/poll/log/…) for follow-up" does not apply to an alcode run. Call no `process` action on the alcode session, before or after the acknowledgement, including `poll` and `log`. The wake turn locates the session file with `alcode status --ticket <id>` (or `--no-ticket`).

As soon as the run is backgrounded, tell the user — in the user's language — that the coding agent is now working in the background and that you will report back when it finishes (e.g. *"The coding agent is running in the background — I'll let you know as soon as it's done."*). Post it even when the user asked to be notified only at completion: this line is the promise of exactly that, not an interruption — a launch with no acknowledgement reads as a session gone silent. The acknowledgement is the plain text that ends the turn on every surface. Only the final message is guaranteed to post, so write nothing and call no tool after it. Do **not** also post it via `message`, and do **not** poll.

Every run writes a session file under `.plans/`: `.plans/<ticket>/_alcode/<stamp>.md`, or `.plans/_alcode/<stamp>.md` without a ticket. This file is the durable record of the run. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

**One protocol run at a time per workspace** — protocol runs share the working tree. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## After a background run completes

The chained `openclaw agent` command starts the next turn of this session with its message when the backgrounded `alcode` exits. A run counts as pending while it is running **and until its outcome is reported**.

The chained `openclaw agent` command blocks until the wake turn ends, so the background exec itself completes after the report. OpenClaw's native exec-exit notice then arrives as a later heartbeat turn with nothing to report. End that turn with exactly `HEARTBEAT_OK`.

When the completion message arrives, do exactly this:

1. **Reconcile the run, then read its session file.** Run `alcode status --ticket <id>` (or `--no-ticket`) from the workspace; its `sessionFile:` line names the run's file. If it reports `running`, keep the run pending and end the turn with exactly `HEARTBEAT_OK`. Otherwise read the file. Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome.
2. **Verify, then report — one message that ends the turn.** Run the verification your operating instructions prescribe. Any `alcode` run launched from this wake turn — a manual test, a review, the next work item — launches exactly like the first one: backgrounded, with the chained completion wake; its report is then the launch ack and the outcome lands on that run's own wake. Then report, in the user's language, where the work was requested:

   `Coding run {succeeded | failed} — the agent reports: {one-line summary of the Result block}. {What you verified.}`

   The report is the plain text that ends the turn, on Slack and Discord alike. It must be the turn's **final message**: text written between tool calls may never post. Never end silently after a completed run.
3. **Don't reconstruct what happened.** Verifying the result is what your operating instructions prescribe; re-deriving the run's story is not: no re-running the coding agent, no fetch/merge, no `git` archaeology to double-check its account — the session file is authoritative for that.

Reporting the run is not calling the work done: the report relays the agent's claim plus what you verified. When your verification finds a failing check, the report says so, and the fix is new work — a fresh run with its own completion wake; the wake you were answering is discharged by your report.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry. When a session turns bad, keep everything in place — session files, directories, and records are the durable audit trail; never delete them; just start a new session.

If the frontmatter's `exitReason` is `auth_required`, the coding agent is not authenticated on the host. An administrator must authenticate with {{AUTH_COMMAND}} before another run. Tell the user exactly that and do not retry.

{{CLI_REFERENCE}}
