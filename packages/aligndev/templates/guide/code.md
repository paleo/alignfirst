{{#openclaw}}
# AlignFirst Delegation Guide (OpenClaw)
{{/openclaw}}
{{#codingAgent}}
# AlignFirst Delegation Guide
{{/codingAgent}}

Run a coding agent through AlignFirst protocols with `{{ALIGNDEV}} code`. It wraps a coding-agent CLI for non-interactive use: it invokes a protocol, streams the run to a session file, and returns the result. The coding agent `{{ALIGNDEV}} code` launches is **the coder**.

**Never implement, investigate, or modify the codebase yourself. Your role is to delegate and guide the coder.**

Run `{{ALIGNDEV}} code` from the root of the target project, so the coder works in the right repository. The project must have a `.plans/` directory, in the repository or in its companion directory.

{{ALIGNFIRST_SETUP}}

{{#openclaw}}
## How it runs

`{{ALIGNDEV}} code` runs the coder in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): **always run `{{ALIGNDEV}} code` as a background task**, so you stay free while it works. The backgrounding is **your platform's** job, never aligndev's own.

Under OpenClaw, background it through the `exec` tool:

- Before the first `{{ALIGNDEV}} code` run of this session, call the `session_status` tool and read the `Session:` line from its result — that is this session's key. Obtain it once, reuse it for every run of this session.
- The exec command chains a completion wake onto the run:

  `{{ALIGNDEV}} code <command> <options> ; openclaw system event --text "aligndev code run finished — read its session file and report to the user" --mode now --session-key <KEY>`

  Chain with `;` (never `&&`) so a failed run wakes you too, and keep the `;` on the same line as the `{{ALIGNDEV}} code` command: a line that starts with `;` is a shell syntax error, the wake command never runs, and the run's completion is lost. The wake may reach you as a bare heartbeat with the text dropped, and OpenClaw's own `Exec completed` notice may lag behind it. Never wait for either text.
- Pass `background: true` and `timeoutSeconds: 0` (no kill timer). Never rely on the auto-yield or a finite timeout.
- For a run launched without `--ticket` or `--no-ticket`, pass `--meta <KEY>` with this session's key. `{{ALIGNDEV}} code status --meta <KEY>` then finds its result among concurrent runs in the shared main worktree.
- Set the exec `workdir` to the project root as an **absolute** path (`~` is not expanded there), or `cd` into the project inside the command itself.
- The acknowledgement's "Use process (list/poll/log/…) for follow-up" does not apply to an `{{ALIGNDEV}} code` run. Call no `process` action on the `{{ALIGNDEV}} code` session, before or after the acknowledgement, including `poll` and `log`.

As soon as the run is backgrounded, tell the user — in the user's language — that the coder is now working in the background and that you will report back when it finishes (e.g. *"The coder is running in the background — I'll let you know as soon as it's done."*). Post it even when the user asked to be notified only at completion: this line is the promise of exactly that, not an interruption — a launch with no acknowledgement reads as a session gone silent. The acknowledgement is the plain text that ends the turn on every surface. Only the final message is guaranteed to post, so write nothing and call no tool after it. Do **not** also post it via `message`, and do **not** poll.

Each ticketed run writes `.plans/<ticket>/_aligndev/<stamp>.md`. This file is the durable record of the run. It may live in the project's companion directory; the `sessionFile:` line of `{{ALIGNDEV}} code status` gives the actual path. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

**One protocol run at a time per workspace** — protocol runs share the working tree. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## After a background run completes

The chained wake fires when the backgrounded `{{ALIGNDEV}} code` exits. This session receives a heartbeat, often as a plain heartbeat poll with no message text. A run counts as pending while it is running **and until its outcome is reported**.

**First, decide whether this heartbeat needs a report.** A heartbeat is a completion wake only while a run is pending. Once you have reported the outcome, later heartbeats for that run need nothing. End them with exactly `HEARTBEAT_OK`, alone.

Any heartbeat received while an `{{ALIGNDEV}} code` run is **still pending** enters this completion procedure:

1. **Reconcile the run, then read its session file.** Run `{{ALIGNDEV}} code status <session-file>` from the run's worktree when you retained its path. Otherwise, for a ticket run, use `{{ALIGNDEV}} code status --ticket <id>`, including `side-N`; its `sessionFile:` line names the newest run's file. For a run tagged with this session's key, use `{{ALIGNDEV}} code status --meta <KEY>`: it selects the newest run carrying that key, wherever it sits under `.plans/`. The shared worktree may hold runs from other threads, so never select its newest run indiscriminately. If it reports `running`, keep the run pending and end the turn with exactly `HEARTBEAT_OK`. Otherwise read the file. Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome.
2. **Verify, then report — one message that ends the turn.** Run the verification your operating instructions prescribe. Any `{{ALIGNDEV}} code` run launched from this completion turn — a manual test, a review, the next work item — launches exactly like the first one: backgrounded, with the chained completion wake. Its report becomes the launch acknowledgement, and the outcome lands on that run's own wake. Then report, in the user's language, where the work was requested:

   `Coding run {succeeded | failed} — the coder reports: {one-line summary of the Result block}. {What you verified.}`

   For a read-only question, answer it directly from the findings; include a failure or uncertainty when relevant. The coding-run template above is for change reports.

   The report is the plain text that ends the turn, on Slack and Discord alike. It must be the turn's **final message**: text written between tool calls may never post. Never follow it with `NO_REPLY`, `HEARTBEAT_OK`, a duplicate message-tool post, or another tool call.
3. **Don't reconstruct what happened.** Verifying the result is what your operating instructions prescribe; re-deriving the run's story is not: no re-running the coder, no fetch/merge, no `git` archaeology to double-check its account — the session file is authoritative for that.

Reporting the run is not calling the work done: the report relays the coder's claim plus what you verified. When your verification finds a failing check, the report says so, and the fix is new work — a fresh run with its own completion wake; the wake you were answering is discharged by your report.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry. When a session turns bad, keep everything in place — session files, directories, and records are the durable audit trail; never delete them; just start a new session.

If the frontmatter's `exitReason` is `auth_required`, the coding agent is not authenticated on the host. An administrator must authenticate with {{AUTH_COMMAND}} before another run. Tell the user exactly that and do not retry.
{{/openclaw}}
{{#codingAgent}}
## How it runs

`{{ALIGNDEV}} code` runs the coder in the **foreground** and blocks until it finishes, streaming the transcript to stdout. It never backgrounds or detaches itself.

Its first line, `Session file: <path>`, names the run's session file, the durable record of the run; retain that path. The file may live in the project's companion directory. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

Coding runs can be long (several hours is fine), and a foreground command is subject to your tool timeout (10 minutes in Claude Code). **Always start `{{ALIGNDEV}} code` with your own background-execution facility, with no time limit.** Never detach it with `&` or a detach wrapper.

Run `{{ALIGNDEV}} code` outside your sandbox: the coder needs network access, and it writes outside the project, to its own session storage and possibly to the companion directory. In Codex, request escalated permissions for the command. In Claude Code with sandboxing enabled, run it with the sandbox disabled.

**One protocol run at a time per worktree** — protocol runs share the working tree. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## Background runs and reporting

Once the run is started, end the turn telling the user, in their language, that the coder is working. Do not poll the run. A run is pending until you report its outcome.

- When your harness wakes the session as the command exits (Claude Code does), follow "After a run completes" on that wake.
- Otherwise (Codex has no such wake today), the report waits for the user's next message. At the start of each later user turn, before anything else, check every pending run with `{{ALIGNDEV}} code status <session-file>`, and report the ones that finished.

## After a run completes

Run `{{ALIGNDEV}} code status <session-file>`. This reconciles a stale `running` record before reporting its status. Then read the session file and report the outcome to the user in this conversation. If the run failed, say so plainly and propose the next step; don't silently retry.

An `exitReason` of `auth_required` in the frontmatter (`{{ALIGNDEV}} code` also exits `2`) means the coding agent is not authenticated on this machine. Tell the user to authenticate with {{AUTH_COMMAND}}, and do not retry.

Don't reconstruct what happened: no re-running the coder, no `git` archaeology to double-check its account — the session file is authoritative for that. Verifying the result is different: run the verification your operating instructions prescribe before reporting. A failing check is new work, in a new coder run.

Keep session files in place; they are the durable audit trail.
{{/codingAgent}}

## CLI reference

```
{{ALIGNDEV}} code new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
{{ALIGNDEV}} code new --catchup --ticket <id> [--protocol <protocol>] [--message-file <path|->]
{{ALIGNDEV}} code new --message "..."
{{ALIGNDEV}} code resume <sessionId> [--protocol <protocol>] [--message "..."]
{{ALIGNDEV}} code status (<session-file> | --ticket <id> | --no-ticket)
{{ALIGNDEV}} code quota
```

| Command | Description |
|---------|-------------|
| `new` | Start a new session. |
| `resume <sessionId>` | Continue an existing session. |
| `status` | Reconcile and show one run's durable status, including `contextTokens`. Give the session file, or `--ticket <id>` / `--no-ticket` to select the newest run of that scope. Does not start the coder. |
| `quota` | Show the selected coding agent's account limits and reset times. Takes no option. |

| Option | Description |
|--------|-------------|
| `--protocol <p>` | One of `spec`, `plan`, `aad`, `description`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. With `status`, selects that ticket's newest run. `new --protocol` requires it, or `--no-ticket`. |
| `--no-ticket` | With `status`, selects the newest run outside a ticket. With `new --protocol`, `{{ALIGNDEV}} code` reserves the next side ticket through `{{ALIGNFIRST}} ticket --side` and passes it to the coder. The reserved id is in the session file's path and `ticket:` frontmatter; pass it as `--ticket side-N` in later runs. |
| `--message "..."` | Message to send, written in English. `-m` is the short form. Required for `spec`, `aad`, and when neither `--protocol` nor `--catchup` is given. A message file also satisfies this requirement. |
| `--message-file <path>` | Read a UTF-8 message file; `-` reads stdin. Mutually exclusive with `--message`. |
| `--catchup` | Load the ticket history before the protocol and message. `new` only, requires a ticket. Alone, it returns a short synthesis. |
| `--model <model>` | One of {{MODELS}}. Prefer the default model (omit the flag). |
| `--meta "..."` | Opaque handoff string stored verbatim in the session file's `meta:` frontmatter. `{{ALIGNDEV}} code` never reads it — it's for you to stash context the run's later reader needs (e.g. where to report the outcome). |

The current coding agent is `{{AGENT}}`. `code.models` in the aligndev config replaces its displayed allowlist. Codex aliases `astra`, `sol`, `terra`, and `luna` resolve to the newest bundled matching slug only when selected; a configured full slug passes through unchanged.

`{{ALIGNDEV}} code status` checks that a `running` process still owns its recorded pid. A dead run is sealed as `status: failed`, `exitReason: terminated` before the command reports it. `{{ALIGNDEV}} code quota` works without a `.plans` directory and does not start a coding session. Its output follows the selected agent's available account limits.

`contextTokens` is what the run left in the coder's context window, measured from its last model response. It describes the conversation, so resuming a session carries the figure forward and each run reports a larger one.

{{ALIGNFIRST_USE}}

{{PERMISSIONS}}.

For `new` runs, the `Session ID:` is printed to stdout and written with `agent: {{AGENT}}` in the session file frontmatter. Save it to resume the conversation later. Resume requires the same selected agent; agentless legacy sessions require a new session.

**No protocol or catchup:** the message is sent as-is (no AlignFirst command). Use it to answer the coder's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
{{ALIGNDEV}} code resume <sessionId> --message "Your answer"
{{ALIGNDEV}} code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `new` and no protocol, the coder will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default workflow. Always start with it, except for very insignificant tasks.

For large work, do not rush. Decompose it yourself only when the concerns are truly distinct; otherwise write one big spec, iterate on discussing it with the coder, then translate it into one or several plans.

1. **Spec** — `{{ALIGNDEV}} code new --protocol spec --ticket AB-123 --message "Feature description"`. The coder investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — the spec run's context decides where planning happens. Read `contextTokens` from `{{ALIGNDEV}} code status`, then follow "Where the plan runs" below.
3. **Execute** — `{{ALIGNDEV}} code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The coder implements and writes a summary file. Given a main plan, it spawns one subagent per sub-plan and writes a main summary; when the working tree is clean, append to the message: *"Feel free to commit between each plan."*
4. **Commit** — use the suggested commit message from the spec file.

Run the chain end to end. The plan is a step of the implementation, not a checkpoint for your user to clear: the moment it's written, launch the execution.

### Where the plan runs

Planning in the spec's own session is cheaper: the coder already holds the investigation. That advantage ends once the session fills up, because the spec discussion competes with the planning work for the same context window. `contextTokens` in the `{{ALIGNDEV}} code status` output is the measure; the threshold is **150k**.

Read `contextCompacted` first. When it is `true`, the coder compacted the conversation: the investigation now survives only as a summary, so the advantage of staying is already gone. Plan in a fresh session whatever `contextTokens` says. Treat an empty `contextTokens` the same way — `contextTokensError` says why the figure is missing, and an unknown occupancy is not a reason to gamble on staying.

**Below 150k — plan in the spec session.** Send the protocol with no message:

```bash
{{ALIGNDEV}} code resume <sessionId> --protocol plan
```

**At or above 150k — make the spec stand alone, then plan in a fresh session.** The next session reads the spec file and nothing else, so the spec must carry every decision the discussion settled. Ask for that first, in the session that holds the discussion:

```bash
{{ALIGNDEV}} code resume <sessionId> --message "Ensure this spec is self-sufficient: another session will write the plans from it."
```

Then start the planning session, naming the spec so the coder does not have to guess among the ticket's files:

```bash
{{ALIGNDEV}} code new --protocol plan --ticket AB-123 --message "spec: \`.plans/AB-123/A1-spec.md\`"
```

Either way the coder writes the plan file, or several sub-plans and a main plan for large work.

Plan files are the coder's material: never read one, main plans included. When the user hands you a plan to execute, pass its path in the message as-is; for context, read the spec that shares the plan's leading letter in the same directory (`A1-spec.md` for `A2-plan.md`), when there is one.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The coder investigates, discusses, then implements in one session.

```bash
{{ALIGNDEV}} code new --protocol aad --ticket AB-123 --message "Task description"
```

Answer questions as in the spec flow. The coder implements and writes a summary file, which carries a suggested commit message. Commit with it.

### Escalation to a spec

If the discussion reveals that the work needs a specification, stop AAD and switch within the same session. Resume without a protocol, and begin the message exactly as follows before giving the discussion answer:

```text
Stop AAD now. Start a spec instead (alignfirst).

<discussion answer>
```

## Review workflow

Two fresh sessions: one reviews, one fixes.

1. **Review** — `{{ALIGNDEV}} code new --protocol review --ticket AB-123`. The coder reviews the current branch against the base branch and writes a review file; its path is in the run's result. The base defaults to the repository's default branch; override it via `--message "Base branch: \`develop\`"`. Retain the session id.
   - **Follow up** (someone else's branch, its author pushed fixes) — `{{ALIGNDEV}} code resume <sessionId> --message "Fixes have been pushed, please check."`, in the review session, with the author's replies to the review appended when there are any. The coder checks its findings against the new commits and reports which are resolved and which remain. A new review session would start over.
2. **Fix** (optional, always in a fresh session — never in the review session) — `{{ALIGNDEV}} code new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"`. Point the message at wherever the review lives: the review file, or the PR/MR whose comments carry it. The coder proposes fixes; decide together what to fix, as in any AAD session. Keep it simple and avoid overengineering. When the coder asks about scope, welcome expansion that cleans things up and refuse expansion that adds complexity; simplicity wins. The coder then implements and writes a summary file.

Skip the fix step when the review is informational.

## Catch up on a ticket

`--catchup` gives a new session the ticket's history (requests, specs, reviews, summaries) before the protocol and message. Use it when the ticket has prior work, for a status synthesis, or to start AAD or spec on an existing ticket:

```bash
{{ALIGNDEV}} code new --ticket AB-123 --catchup                  # short synthesis of the history
{{ALIGNDEV}} code new --ticket AB-123 --catchup --protocol aad --message-file - <<'ALIGNDEV_MESSAGE'
Investigate `someFunction()` and the literal expression $(example).
ALIGNDEV_MESSAGE
```

Prefer `--message-file` for long or multi-line messages. A quoted heredoc delimiter keeps quotes, backticks and dollar signs literal in Bash.

## Other protocols

- **description** — `{{ALIGNDEV}} code new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **review** — see the review workflow above.
- **merge** — `{{ALIGNDEV}} code new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering the coder's questions

During spec and AAD sessions the coder asks questions before proceeding, as `Q1`, `Q2`… blocks, each with a ➡️ recommendation. A lone ➡️ line is a proposal waiting for your go or veto; sort it like a question. Resume **without a protocol** to answer. Compose the answers in English, all in one message, numbered to match:

```bash
{{ALIGNDEV}} code resume <sessionId> --message \
  "Q1 - Explore the codebase and give me your opinion.
Q2 - Is that a good design? We need the cleanest code possible.
Q3 - Yes, it should be optional.
Go for all your other ➡️ proposals, except: <the vetoed proposal and what to do instead>."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the coder to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the elegant, proper, simple yet robust solution?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the coder to explore first. Escalate only when the question truly cannot be answered from the codebase.
