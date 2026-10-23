{{#openclaw}}
# AlignFirst Delegation Guide (OpenClaw)
{{/openclaw}}
{{#codingAgent}}
# AlignFirst Delegation Guide
{{/codingAgent}}

Run a coding agent through AlignFirst protocols with `{{ALIGNDEV}} code`. It wraps a coding-agent CLI for non-interactive use: it invokes a protocol, streams the run to a session file, and returns the result. The coding agent `{{ALIGNDEV}} code` launches is **the agent**.

**Never implement, investigate, or modify the codebase yourself. Your role is to delegate and guide the agent.**

Run `{{ALIGNDEV}} code` from the root of the selected worktree, so the agent works in the right repository. The project must have usable `.plans/`, in the repository or in its companion directory: `{{ALIGNFIRST}} plans check` verifies it, and `{{ALIGNDEV}} guide work-files-setup` prepares it.

{{ALIGNFIRST_SETUP}}

Each ticketed run writes `.plans/<ticket>/_aligndev/<stamp>.md`. This file is the durable record of the run. It may live in the project's companion directory; the `sessionFile:` line of `{{ALIGNDEV}} code status` gives the actual path. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome. A run that answers more than once lists each response oldest first, separated by `---- Later result ----`. A substantive report may precede a short later acknowledgement; report the substantive outcome.

{{#openclaw}}
## How it runs

`{{ALIGNDEV}} code` runs the agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

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

As soon as the run is backgrounded, tell the user — in the user's language — that the agent is now working in the background and that you will report back when it finishes (e.g. *"The agent is running in the background — I'll let you know as soon as it's done."*). Post it even when the user asked to be notified only at completion: this line is the promise of exactly that, not an interruption — a launch with no acknowledgement reads as a session gone silent. The acknowledgement is the plain text that ends the turn on every surface. Only the final message is guaranteed to post, so write nothing and call no tool after it. Do **not** also post it via `message`, and do **not** poll.

**One protocol run at a time per workspace and per ticket** — protocol runs share the working tree, and the ticket's work files. Finish (or kill) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## After a background run completes

The chained wake fires when the backgrounded `{{ALIGNDEV}} code` exits. This session receives a heartbeat, often as a plain heartbeat poll with no message text. A run counts as pending while it is running **and until its outcome is reported**.

**First, decide whether this heartbeat needs a report.** A heartbeat is a completion wake only while a run is pending. Once you have reported the outcome, later heartbeats for that run need nothing. End them with exactly `HEARTBEAT_OK`, alone.

Any heartbeat received while an `{{ALIGNDEV}} code` run is **still pending** enters this completion procedure:

1. **Reconcile the run, then read its session file.** Run `{{ALIGNDEV}} code status <session-file>` from the run's worktree when you retained its path. Otherwise, for a ticket run, use `{{ALIGNDEV}} code status --ticket <id>`, including `side-N`; its `sessionFile:` line names the newest run's file. For a run tagged with this session's key, use `{{ALIGNDEV}} code status --meta <KEY>`: it selects the newest run carrying that key, wherever it sits under `.plans/`. The shared worktree may hold runs from other threads, so never select its newest run indiscriminately. If it reports `running`, keep the run pending and end the turn with exactly `HEARTBEAT_OK`. Otherwise read the file. Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome.
2. **Verify, then report — one message that ends the turn.** Run the verification your operating instructions prescribe. Any `{{ALIGNDEV}} code` run launched from this completion turn — a manual test, a review, the next work item — launches exactly like the first one: backgrounded, with the chained completion wake. Its report becomes the launch acknowledgement, and the outcome lands on that run's own wake. Then report, in the user's language, where the work was requested:

   `Coding run {succeeded | failed} — the agent reports: {one-line summary of the Result block}. {What you verified.}`

   For a consultation, answer it directly from the findings; include a failure or uncertainty when relevant. The coding-run template above is for change reports.

   The report is the plain text that ends the turn, on Slack and Discord alike. It must be the turn's **final message**: text written between tool calls may never post. Never follow it with `NO_REPLY`, `HEARTBEAT_OK`, a duplicate message-tool post, or another tool call.
3. **Don't reconstruct what happened.** Verifying the result is what your operating instructions prescribe; re-deriving the run's story is not: no re-running the agent, no fetch/merge, no `git` archaeology to double-check its account — the session file is authoritative for that.

Reporting the run is not calling the work done: the report relays the agent's claim plus what you verified. When your verification finds a failing check, the report says so, and the fix is new work — a fresh run with its own completion wake; the wake you were answering is discharged by your report.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry. When a session turns bad, keep everything in place — session files, directories, and records are the durable audit trail; never delete them; just start a new session.

If the frontmatter's `exitReason` is `auth_required`, the coding agent is not authenticated on the host. An administrator must authenticate with {{AUTH_COMMAND}} before another run. Tell the user exactly that and do not retry.
{{/openclaw}}
{{#codingAgent}}
## How it runs

`{{ALIGNDEV}} code` runs the agent in the **foreground** until it exits. It never backgrounds or detaches itself. By default it streams the transcript to stdout; `--quiet` suppresses that stream while preserving the durable session file and control/diagnostic output.

Choose the launch facility from your **parent host**, independently of the selected child `{{AGENT}}`. The selected profile chooses the child only. All three children (Claude Code, Codex, Pi) remain available from any supported parent.

**One protocol run at a time per worktree and per ticket** — protocol runs share the working tree, and the ticket's work files. Finish (or cancel) the current protocol run before launching or resuming another. Plain messages (answers, questions) can be sent at any time.

## Background runs and reporting

### Pi parent

Before launching, establish that the `background` tool is available and that this parent stays alive after its acknowledgement. A one-shot print/JSON process is not a persistent assistant. Missing capability is an installation problem: explain that the parent needs `pi install npm:@alignfirst/pi-background`. The AlignDev skill alone supplies no executable tools. Do not substitute a blocking ordinary bash call, shell `&`, `nohup`, or a detach wrapper, or promise a wake without the facility.

Retain these distinct values for each run:

- The original absolute worktree and this parent conversation's identity.
- The returned background job handle (`job.id`), which authorizes job status and cancellation.
- A fresh unique per-run `--meta` key, never reused for a successor or resume.
- The exact AlignDev session-file path once resolved, including a companion location when applicable.
- The child conversation ID (`sessionId`) for resume. It is neither a job handle nor a run-file path.

Prepare the literal delegated prompt in a UTF-8 file, then launch the ordinary quoted shell command through `background` with `action: "start"` and `cwd`. Supply `--quiet --meta <unique-run-key>` yourself; the extension never parses or appends CLI options. This example assumes `/tmp/aligndev-request.txt` already contains the request. Generate a fresh key for every actual launch; the UUID below illustrates one run:

```json
{"action":"start","command":"{{ALIGNDEV}} code new --message-file '/tmp/aligndev-request.txt' --quiet --meta 'a20bc7c1-c056-4d07-8cc2-90fe491a6df6'","cwd":"/srv/projects/example","label":"coding run"}
```

For resume, use `{{ALIGNDEV}} code resume <sessionId> --message-file <path> --quiet --meta <fresh-run-key>` from the original worktree. A Pi child must resume from its recorded directory. Use safe shell quoting for paths and options; never interpolate raw user text into a command. A quoted heredoc with `--message-file -` is another literal-input route.

Start returns after OS spawn acknowledgement. Retain its handle, key and cwd immediately; **do not wait for the `Session file:` control line**. End the launch turn with an acknowledgement in the user's language, then call no tool and do not poll while waiting. Natural completion requests an idle turn or a follow-up after busy work. A completion notice is only a wake hint.

On a notice:

1. Query `background` with `{"action":"status","id":"<returned-job-id>"}` first. This event-triggered ownership check is not a waiting or polling loop. Disregard an inactive origin or an unknown/retired/cleared handle: it can be a stale native notice after clear, navigation or reload and authorizes no workflow action. A still-running job authorizes no completion report.
2. For a current-owner terminal job, run `{{ALIGNDEV}} code status <exact-file> --result` from its original worktree. If the path is not yet known, use `{{ALIGNDEV}} code status --meta <unique-run-key> --result` there. Resolve the returned `sessionFile:` relative to that worktree when necessary, retain its exact path, and use that path thereafter. Never fall back to the newest workspace or ticket run when identity is unknown. A launch can fail before creating a run file; report that failure rather than choosing another run.
3. Read the authoritative status, `exitReason`, child `sessionId` and final Result from this response. `--result` excludes the transcript; the CLI imposes no numeric byte cap on final result text. Background output contains only quiet control/diagnostic output. Inspect it with `action: "output"`, or inspect the durable transcript, only for a specific diagnostic need.
4. Continue authorized verification and dependent work, or ask genuine user questions and report authentication failures or blockers. One child turn does not complete the whole request. Record which outcome you handled so a repeated notice cannot duplicate reporting or launch successor work twice. Never rerun coding merely to retry reporting.

Cancel through `background` with `{"action":"stop","id":"<returned-job-id>"}`. It gives attached work a five-second graceful window before escalation, allowing the CLI to seal its durable file. Preserve session files; `clear` removes only a terminal generic job record and its retained output.

**Host limits:** standalone manual compaction or cancelled/failed navigation can delay a notice until another ordinary turn. Interruption or native queue clearing can lose automatic continuation. Already-submitted notices can appear after navigation or reload; validate ownership as above. Delivery is not exactly once. Normal shutdown, session replacement, successful tree navigation and `/reload` cancel owned work; crash recovery is not promised.

Pi uses ordinary OS permissions and saved project trust, not an implied sandbox. `profile.skipPermissions` does not elevate Pi or force project approval.

### Claude Code parent

Coding runs can be long (several hours is fine), and a foreground command is subject to your tool timeout (10 minutes in Claude Code). Use your own background-execution facility with no time limit. When sandboxing is enabled, run `{{ALIGNDEV}} code` with the sandbox disabled: the child needs network and writes outside the project. Retain the initial `Session file: <path>` control line. End the launch turn on its acknowledgement without polling; follow "After a run completes" when the harness wakes the session as the command exits.

### Codex parent

Use your established background-execution facility with no time limit and request escalated permissions for `{{ALIGNDEV}} code`. Retain the initial `Session file: <path>` control line. End the launch turn on its acknowledgement without polling. Where no completion bridge is configured, the report waits for the user's next message. At the start of each later user turn, before anything else, check every pending run with `{{ALIGNDEV}} code status <session-file>`, and report the ones that finished. This fallback does not assert that Codex lacks native queue capability.

Neither parent detaches with `&` or a wrapper. A run is pending until its outcome is handled.

## After a run completes

**Pi parent:** use the ownership and result-only procedure above. **Claude Code or Codex parent:** run `{{ALIGNDEV}} code status <session-file>` to reconcile stale status, then read the session file and report in this conversation.

An `exitReason` of `auth_required` (`{{ALIGNDEV}} code new/resume` exits `2`) means the selected child is not authenticated on this machine. Tell the user to authenticate with {{AUTH_COMMAND}}, and do not retry. Other launch/run failures exit `1`; success exits `0`. A successful `status` query exits `0` even for a failed run: read its `status` and `exitReason`.

Don't reconstruct what happened: no re-running the agent, no `git` archaeology to double-check its account — the session file is authoritative for that. Run the verification your operating instructions prescribe. A failing check is new work, in a new agent run; do not silently retry. Keep session files as the durable audit trail.
{{/codingAgent}}

## CLI reference

```
{{ALIGNDEV}} code new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
{{ALIGNDEV}} code new --catchup --ticket <id> [--protocol <protocol>] [--message-file <path|->]
{{ALIGNDEV}} code new --message "..."
{{ALIGNDEV}} code resume <sessionId> [--protocol <protocol>] [--message "..."]
{{#openclaw}}
{{ALIGNDEV}} code status (<session-file> | --ticket <id> | --no-ticket)
{{/openclaw}}
{{#codingAgent}}
{{ALIGNDEV}} code new --message-file <path> --quiet --meta <unique-run-key>
{{ALIGNDEV}} code resume <sessionId> --message-file <path> --quiet --meta <unique-run-key>
{{ALIGNDEV}} code status (<session-file> | --ticket <id> | --no-ticket | --meta <key>) [--result]
{{/codingAgent}}
{{ALIGNDEV}} code quota [--profile <name>]
```

| Command | Description |
|---------|-------------|
| `new` | Start a new session. |
| `resume <sessionId>` | Continue an existing session. |
{{#openclaw}}
| `status` | Reconcile and show one run's durable status, including `contextTokens`. Give the session file, or `--ticket <id>` / `--no-ticket` to select the newest run of that scope. Does not start the agent. |
| `quota` | Show the profile's native quota source and account limits. Accepts `--profile`; independent of the coding child. |
{{/openclaw}}
{{#codingAgent}}
| `status` | Reconcile and show one run's durable status, including `contextTokens`. Select exactly one file, `--ticket <id>`, `--no-ticket`, or `--meta <key>`; scope/key selectors choose their newest matching run. Does not start the agent. |
| `quota` | Show the profile's native quota source and account limits. Accepts `--profile`; independent of the coding child. |
{{/codingAgent}}

| Option | Description |
|--------|-------------|
| `--profile <name>` | Select a complete named profile for new/resume/quota or agent-specific help; also accepted by `guide code`. Rejected on status. |
| `--protocol <p>` | One of `spec`, `plan`, `aad`, `description`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. With `status`, selects that ticket's newest run. `new --protocol` requires it, or `--no-ticket`. |
| `--no-ticket` | With `status`, selects the newest run outside a ticket. With `new --protocol`, `{{ALIGNDEV}} code` reserves the next side ticket through `{{ALIGNFIRST}} ticket --side` and passes it to the agent. The reserved id is in the session file's path and `ticket:` frontmatter; pass it as `--ticket side-N` in later runs. |
| `--message "..."` | Message to send, written in English. `-m` is the short form. Required for `spec`, `aad`, and when neither `--protocol` nor `--catchup` is given. A message file also satisfies this requirement. |
| `--message-file <path>` | Read a UTF-8 message file; `-` reads stdin. Mutually exclusive with `--message`. |
| `--catchup` | Load the ticket history before the protocol and message. `new` only, requires a ticket. Alone, it returns a short synthesis. |
| `--model <model>` | {{MODEL_POLICY}}. A new session defaults to {{DEFAULT_MODEL}}; a resume keeps the session's model. Prefer the default (omit the flag). |
{{#openclaw}}
| `--meta "..."` | Opaque handoff string stored verbatim in the session file's `meta:` frontmatter. `{{ALIGNDEV}} code` never reads it — it's for you to stash context the run's later reader needs (e.g. where to report the outcome). |
{{/openclaw}}
{{#codingAgent}}
| `--meta <key>` | On `new/resume`, store an opaque handoff key verbatim. On `status`, select the newest run with that exact key anywhere in the active session tree. Use a unique key per run for exact asynchronous lookup. |
| `--quiet` | `new/resume` only. Suppress live transcript stdout, preserving the durable transcript, initial `Session file:` line, new `Session ID:`, and failure diagnostics. |
| `--result` | `status` only. Append a terminal run's final Result when present, without transcript output. Running runs show metadata only. No numeric final-text byte cap. |
{{/codingAgent}}

{{#openclaw}}
The current coding agent is `{{AGENT}}`, profile `{{PROFILE}}`. The profile's nonempty `models` replaces its displayed allowlist. Codex aliases `astra`, `sol`, `terra`, and `luna` resolve to the newest bundled matching slug only when selected; a configured full slug passes through unchanged.

`{{ALIGNDEV}} code status` seals a `running` record only when its `machineId` matches this installation and its pid is conclusively gone or reused. Foreign, legacy and uncertain records stay `running`; a sealed run reports `status: failed`, `exitReason: terminated`. `{{ALIGNDEV}} code quota` works without a `.plans` directory and does not start a coding session. Its output belongs to the selected native quota CLI's account; account pairing with the coding child is not verified.
{{/openclaw}}
{{#codingAgent}}
The current coding agent is `{{AGENT}}`, profile `{{PROFILE}}`. A nonempty profile `models` list replaces its accepted model list. Pi has no finite allowlist by default: native selectors pass through unchanged, preferably `provider/model`, with optional thinking suffix. For a Pi child without `--model`, a new run uses profile `defaultModel`, else Pi's own default; a resume retains and validates its recorded model. Codex aliases `astra`, `sol`, `terra`, and `luna` resolve to the newest bundled matching slug only when selected; a configured full slug passes through unchanged.

`{{ALIGNDEV}} code status` seals a `running` record only when its `machineId` matches this installation and its pid is conclusively gone or reused. Foreign, legacy and uncertain records stay `running`; a sealed run reports `status: failed`, `exitReason: terminated`. `{{ALIGNDEV}} code quota` needs no `.plans` and starts no session. Its output belongs to the selected native quota CLI's account; account pairing with the coding child is not verified.
{{/codingAgent}}

### Profiles and resume

Effective profile: `{{PROFILE}}`; agent: `{{AGENT}}`; native configuration: `{{NATIVE_CONFIG}}`. Environment values are omitted. Login must use the same effective environment as the child: apply profile `unset/env/configDir`, including HOME, PATH and credential routing, from the same working directory. A bare login in another shell may use a different account.

Profile selection, native configuration directories, quota sources and settings migration are configured outside this guide and documented in the `aligndev` README. A selection or settings error fails with the CLI's own diagnostic: report it, and never retry against another account.

`contextTokens` is what the run left in the agent's context window, measured from its last model response. It describes the conversation, so resuming a session carries the figure forward and each run reports a larger one.

{{ALIGNFIRST_USE}}

{{PERMISSIONS}}. The agent needs read and write access to the work files under that policy. A worktree's `.plans` may be a symlink to the main worktree's, and a symlink grants no sandbox permission. Report missing access instead of enabling bypass permissions or granting the whole main repository.

{{#openclaw}}
For `new` runs, the `Session ID:` is printed to stdout and written with `agent: {{AGENT}}` in the session file frontmatter. Save it to resume the conversation later. Resume requires the same selected agent; agentless legacy sessions require a new session.
{{/openclaw}}
{{#codingAgent}}
For `new` runs, the child `Session ID:` is printed to stdout and recorded as `sessionId` with `agent: {{AGENT}}` in the durable session file. An asynchronous Pi parent retains it from authoritative `status --result` retrieval, without waiting at launch. Save it for resume, which requires the same selected child; agentless legacy sessions require a new session.
{{/codingAgent}}

**No protocol or catchup:** the message is sent as-is (no AlignFirst command). Use it to answer the agent's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
{{ALIGNDEV}} code resume <sessionId> --message "Your answer"
{{ALIGNDEV}} code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `new` and no protocol, the agent will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default workflow. Always start with it, except for very insignificant tasks.

For large work, do not rush. Decompose it yourself only when the concerns are truly distinct; otherwise write one big spec, iterate on discussing it with the agent, then translate it into one or several plans.

1. **Spec** — `{{ALIGNDEV}} code new --protocol spec --ticket AB-123 --message "Feature description"`. The agent investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — the spec run's context decides where planning happens. Read `contextTokens` from `{{ALIGNDEV}} code status`, then follow "Where the plan runs" below.
3. **Execute** — `{{ALIGNDEV}} code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The agent implements and writes a summary file.
   For a main plan, end the message with *"Commit at each step."*: the agent spawns one subagent per sub-plan, commits after each, and writes a main summary.
4. **Commit** — use the suggested commit message from the spec file. After a main plan, the commits already exist; only commit what the subagents left uncommitted.

Run the chain end to end. The plan is a step of the implementation, not a checkpoint for your user to clear: the moment it's written, launch the execution.

### Where the plan runs

Planning in the spec's own session is cheaper: the agent already holds the investigation. That advantage ends once the session fills up, because the spec discussion competes with the planning work for the same context window. `contextTokens` in the `{{ALIGNDEV}} code status` output is the measure; the threshold is **160k**.

Read `contextCompacted` first. When it is `true`, the agent compacted the conversation: the investigation now survives only as a summary, so the advantage of staying is already gone. Plan in a fresh session whatever `contextTokens` says. Treat an empty `contextTokens` the same way — `contextTokensError` says why the figure is missing, and an unknown occupancy is not a reason to gamble on staying.

**Below 160k — plan in the spec session.** Send the protocol with no message:

```bash
{{ALIGNDEV}} code resume <sessionId> --protocol plan
```

**At or above 160k — make the spec stand alone, then plan in a fresh session.** The next session reads the spec file and nothing else, so the spec must carry every decision the discussion settled. Ask for that first, in the session that holds the discussion:

```bash
{{ALIGNDEV}} code resume <sessionId> --message "Ensure this spec is self-sufficient: another session will write the plans from it."
```

Then start the planning session, naming the spec so the agent does not have to guess among the ticket's files:

```bash
{{ALIGNDEV}} code new --protocol plan --ticket AB-123 --message "spec: \`.plans/AB-123/A1-spec.md\`"
```

Either way the agent writes the plan file, or several sub-plans and a main plan for large work.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements in one session.

```bash
{{ALIGNDEV}} code new --protocol aad --ticket AB-123 --message "Task description"
```

Answer questions as in the spec flow. The agent implements and writes a summary file, which carries a suggested commit message. Commit with it.

### Escalation to a spec

If the discussion reveals that the work needs a specification, stop AAD and switch within the same session. Resume without a protocol, and begin the message exactly as follows before giving the discussion answer:

```text
Stop AAD now. Start a spec instead (alignfirst).

<discussion answer>
```

## Review workflow

Two fresh sessions: one reviews, one fixes.

1. **Review** — `{{ALIGNDEV}} code new --protocol review --ticket AB-123`. The agent reviews the current branch against the base branch and writes a review file; its path is in the run's result. The base defaults to the repository's default branch; override it via `--message "Base branch: \`develop\`"`. Retain the session id.
   - **Follow up** (someone else's branch, its author pushed fixes) — `{{ALIGNDEV}} code resume <sessionId> --message "Fixes have been pushed, please check."`, in the review session, with the author's replies to the review appended when there are any. The agent checks its findings against the new commits and reports which are resolved and which remain. A new review session would start over.
2. **Fix** (optional, always in a fresh session — never in the review session) — `{{ALIGNDEV}} code new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"`. Send this message as it is, pointed at wherever the review lives: the review file, or the PR/MR whose comments carry it. The agent challenges the findings and proposes fixes; decide together what to fix, as in any AAD session. The goal is the project's code quality, and a finding is not an order: welcome a fix or an expansion that cleans things up, refuse one that adds complexity; simplicity wins. The agent then implements and writes a summary file.

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

## Answering the agent's questions

During spec and AAD sessions each question opens a topic, `T1`, `T2`…, with a ➡️ recommendation. Resume **without a protocol** to answer. Compose the answers in English, all in one message, numbered to match:

```bash
{{ALIGNDEV}} code resume <sessionId> --message \
  "T1 - Explore the codebase and give me your opinion.
T2 - Is that a good design? We need the cleanest code possible.
T3 - Yes, it should be optional."
```

A question your reply skips or answers partially stays open under its topic. Accept a whole round only once your user has settled every decision that is theirs: "All recommendations accepted, except T3: <what to do instead>."

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the agent to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the elegant, proper, simple yet robust solution?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the agent to explore first. Escalate only when the question truly cannot be answered from the codebase.
