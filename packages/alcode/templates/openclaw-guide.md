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
- If the outcome must be reported into a thread **you created yourself** via `message` `action: "thread-create"`, add `--meta "<THREAD_ID>"` with that thread's `chat_id`: the completion wake's plain reply goes to this session's default surface (the channel), and only the session file's `meta` can point your report back at the thread (via `message` `action: "thread-reply"`). In every other case omit `--meta` — platform-threaded replies and thread-bound sessions already report in the right place.

As soon as the run is backgrounded, tell the user — in the user's language — that the coding agent is now working in the background and that you will report back when it finishes (e.g. *"The coding agent is running in the background — I'll let you know as soon as it's done."*). Then go available. Do **not** poll.

Every run writes a session file under `.plans/`: `.plans/<ticket>/_alcode/<stamp>.md`, or `.plans/_alcode/<stamp>.md` without a ticket. This file is the durable record of the run. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

**One protocol run at a time per workspace** — protocol runs share the working tree. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## After a background run completes

The chained wake fires when the backgrounded `alcode` exits: this session receives a heartbeat, usually as a plain heartbeat poll with no message text (the wake text is often dropped in transit). A run counts as pending while it is running **and until its outcome is reported**. Any heartbeat received while an `alcode` run is pending is the completion wake — do exactly this:

1. **Read the run's session file** (the path `alcode` printed on its first line, under `_alcode/`). Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome. If you set `meta` at launch, it is there too.
2. **Report the outcome to the user** where the work was requested. Send one concise message: succeeded or failed, plus a one-line summary of the result for the audience. Two cases:
   - The frontmatter `meta` carries a destination (e.g. a thread target): send the report there through the `message` tool, then end the wake turn with a final answer of exactly `NO_REPLY` — any other final text streams to the session's default surface as a stray duplicate.
   - No `meta` destination: the work was requested on this session's own surface, so **the report itself is your final reply**. Never end such a wake turn silently.

   A wake turn ends with the report or with exactly `NO_REPLY` — nothing else, ever. The generic heartbeat answer does not apply here: `HEARTBEAT_OK` posts as literal text where the user reads. `NO_REPLY` is the ending after a `message`-tool report, and for a duplicate wake of an already-reported run (a single run can wake you more than once — the platform's own exec-exit notice may fire on top of the chained wake).
3. Do **not** re-verify the repo, re-run the coding agent, fetch/merge branches, or inspect `git`. The coding agent already did the work and the session file is authoritative. Relay its outcome, nothing more.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry. When a session turns bad, keep everything in place — session files, directories, and records are the durable audit trail; never delete them; just start a new session.

{{CLI_REFERENCE}}
