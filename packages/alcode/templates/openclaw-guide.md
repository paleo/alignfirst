# AlignFirst Delegation Guide (OpenClaw)

{{INTRODUCTION}}

## How it runs

`alcode` runs the coding agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): **always run `alcode` as a background task**, so you stay free while it works. The backgrounding is **your platform's** job, never alcode's own.

Under OpenClaw, background it through the `exec` tool:

- Before the first `alcode` run of this session, call the `session_status` tool and read the `Session:` line from its result — that is this session's key. Obtain it once, reuse it for every run of this session.
- The exec command chains a completion wake onto the run:

  `alcode <flags> ; openclaw system event --text "alcode run finished — read its session file and report to the user" --mode now --session-key <KEY>`

  Chain with `;` (never `&&`) so a failed run wakes you too. The wake may reach you as a bare heartbeat with the text dropped, and OpenClaw's own `Exec completed` notice may lag behind it — never wait for either text.
- Pass `background: true` and `timeout: 0` (no kill timer). Never rely on the auto-yield or a finite timeout.
- Set the exec `workdir` to the project root as an **absolute** path (`~` is not expanded there), or `cd` into the project inside the command itself.
- The session-file path comes from the run's first stdout line (`Session file: …`), available via `process log <id>`. The stamp in the file name is the run's start time; it cannot be derived from the clock.
- `--meta` is for one case only: a **Discord** thread **you created yourself** this turn via `message` `action: "thread-create"`. There, the completion wake's plain reply would go to the channel, so add `--meta "<THREAD_ID>"` with that thread's `chat_id`; the wake then reports back into the thread via `message` `action: "thread-reply"`. In **every other case — always on Slack, and on Discord when the session is already thread-bound — omit `--meta`.** Slack auto-threads plain replies and exposes no `send`/`thread-reply` action, so a `--meta` there makes the wake attempt an unsupported `message` send that fails; a thread-bound session already replies in its own thread.

As soon as the run is backgrounded, tell the user — in the user's language — that the coding agent is now working in the background and that you will report back when it finishes (e.g. *"The coding agent is running in the background — I'll let you know as soon as it's done."*). Deliver this "started" ack exactly like the completion report below: if you set `--meta` (a Discord thread you created this turn), the ack is a `message` `action: "thread-reply"` carrying that thread's `threadId` — your free-form text would stream to the parent channel. In every other case — always on Slack, and on a thread-bound Discord session — the ack is your plain text; do **not** also post it via `message`, that double-posts. Then go available. Do **not** poll.

Every run writes a session file under `.plans/`: `.plans/<ticket>/_alcode/<stamp>.md`, or `.plans/_alcode/<stamp>.md` without a ticket. This file is the durable record of the run. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

**One protocol run at a time per workspace** — protocol runs share the working tree. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## After a background run completes

The chained wake fires when the backgrounded `alcode` exits: this session receives a heartbeat, usually as a plain heartbeat poll with no message text (the wake text is often dropped in transit). A run counts as pending while it is running **and until its outcome is reported**.

**First, decide whether this heartbeat needs a report.** A heartbeat is the completion wake only while a run is pending. Once you have already reported a run's outcome, later heartbeats for it — a single run can wake you more than once, since the platform's own exec-exit notice may fire on top of the chained wake — need nothing: end the turn with a final answer of exactly `NO_REPLY`. Never `HEARTBEAT_OK`: it is not swallowed, it posts as literal text where the user reads. Whenever a heartbeat turn has nothing new to say, the answer is `NO_REPLY`, never `HEARTBEAT_OK`.

Any heartbeat received while an `alcode` run is **still pending** (running, or finished but not yet reported) is the completion wake — do exactly this:

1. **Read the run's session file** (the path `alcode` printed on its first line, under `_alcode/`). Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome. If you set `meta` at launch, it is there too.
2. **Report the outcome to the user** — your next action after reading the file, before any other tool call: one concise message where the work was requested, succeeded or failed, plus a one-line summary of the result for the audience. Two delivery cases:
   - The frontmatter `meta` carries a destination (a Discord thread target): post it with `message` `action: "thread-reply"` (never `action: "send"`). Free-form text would stream to the channel as a stray duplicate.
   - No `meta` destination (always the case on Slack, and on a thread-bound Discord session): the work was requested on this session's own surface, so **your plain text is the report** — just write it, no `message` tool. On Slack it auto-threads back to the right thread. Never end such a wake turn silently.
3. **Don't reconstruct what happened.** No re-running the coding agent, no fetch/merge, no `git` archaeology to double-check its account: the session file is authoritative for that, and relaying it is the wake turn's job.

End the wake turn on your last delivered post: after a `message`-tool post, the final answer is exactly `NO_REPLY`; when your plain text was the post, that text is the ending. Never `HEARTBEAT_OK` — it isn't swallowed, it posts as literal text where the user reads.

Reporting the run is not the same as calling the work done. A successful run is the coding agent's claim, and the user hears "done" from you — so verify it the way your platform's instructions prescribe. That verification is its own step, after the report has been delivered: any run you launch for it is new work with its own completion wake, and the wake you were answering is already discharged.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry. When a session turns bad, keep everything in place — session files, directories, and records are the durable audit trail; never delete them; just start a new session.

If the frontmatter's `exitReason` is `auth_required`, the coding agent itself is not authenticated on the host (its session is missing or expired). No run can succeed until an administrator re-logs it in on the host. Tell the user exactly that, and do not retry — a retry hits the same wall.

{{CLI_REFERENCE}}
