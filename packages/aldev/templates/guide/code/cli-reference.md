## CLI reference

```
aldev code new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
aldev code new --catchup --ticket <id> [--protocol <protocol>] [--message-file <path|->]
aldev code new --message "..."
aldev code resume <sessionId> [--protocol <protocol>] [--message "..."]
aldev code status (<session-file> | --ticket <id> | --no-ticket)
aldev code quota
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
| `--no-ticket` | With `status`, selects the newest run outside a ticket. With `new --protocol`, `aldev code` reserves the next side ticket through `alignfirst ticket --side` and passes it to the coder. The reserved id is in the session file's path and `ticket:` frontmatter; pass it as `--ticket side-N` in later runs. |
| `--message "..."` | Message to send, written in English. `-m` is the short form. Required for `spec`, `aad`, and when neither `--protocol` nor `--catchup` is given. A message file also satisfies this requirement. |
| `--message-file <path>` | Read a UTF-8 message file; `-` reads stdin. Mutually exclusive with `--message`. |
| `--catchup` | Load the ticket history before the protocol and message. `new` only, requires a ticket. Alone, it returns a short synthesis. |
| `--model <model>` | One of {{MODELS}}. Prefer the default model (omit the flag). |
| `--meta "..."` | Opaque handoff string stored verbatim in the session file's `meta:` frontmatter. `aldev code` never reads it — it's for you to stash context the run's later reader needs (e.g. where to report the outcome). |

The current coding agent is `{{AGENT}}`. `code.models` in the aldev config replaces its displayed allowlist. Codex aliases `astra`, `sol`, `terra`, and `luna` resolve to the newest bundled matching slug only when selected; a configured full slug passes through unchanged.

`aldev code status` checks that a `running` process still owns its recorded pid. A dead run is sealed as `status: failed`, `exitReason: terminated` before the command reports it. `aldev code quota` works without a `.plans` directory and does not start a coding session. Its output follows the selected agent's available account limits.

`contextTokens` is what the run left in the coder's context window, measured from its last model response. It describes the conversation, so resuming a session carries the figure forward and each run reports a larger one.

`aldev code` requires the `alignfirst` CLI on `PATH`. The coder runs `alignfirst guide <protocol>` in the project, so the protocols come from the installed CLI.

{{PERMISSIONS}}.

For `new` runs, the `Session ID:` is printed to stdout and written with `agent: {{AGENT}}` in the session file frontmatter. Save it to resume the conversation later. Resume requires the same selected agent; agentless legacy sessions require a new session.

**No protocol or catchup:** the message is sent as-is (no AlignFirst command). Use it to answer the coder's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
aldev code resume <sessionId> --message "Your answer"
aldev code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `new` and no protocol, the coder will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default workflow. Always start with it, except for very insignificant tasks.

For large work, do not rush. Decompose it yourself only when the concerns are truly distinct; otherwise write one big spec, iterate on discussing it with the coder, then translate it into one or several plans.

1. **Spec** — `aldev code new --protocol spec --ticket AB-123 --message "Feature description"`. The coder investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — the spec run's context decides where planning happens. Read `contextTokens` from `aldev code status`, then follow "Where the plan runs" below.
3. **Execute** — `aldev code new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The coder implements and writes a summary file. Given a main plan, it spawns one subagent per sub-plan and writes a main summary; when the working tree is clean, append to the message: *"Feel free to commit between each plan."*
4. **Commit** — use the suggested commit message from the spec file.

Run the chain end to end. The plan is a step of the implementation, not a checkpoint for your user to clear: the moment it's written, launch the execution.

### Where the plan runs

Planning in the spec's own session is cheaper: the coder already holds the investigation. That advantage ends once the session fills up, because the spec discussion competes with the planning work for the same context window. `contextTokens` in the `aldev code status` output is the measure; the threshold is **150k**.

Read `contextCompacted` first. When it is `true`, the coder compacted the conversation: the investigation now survives only as a summary, so the advantage of staying is already gone. Plan in a fresh session whatever `contextTokens` says. Treat an empty `contextTokens` the same way — `contextTokensError` says why the figure is missing, and an unknown occupancy is not a reason to gamble on staying.

**Below 150k — plan in the spec session.** Send the protocol with no message:

```bash
aldev code resume <sessionId> --protocol plan
```

**At or above 150k — make the spec stand alone, then plan in a fresh session.** The next session reads the spec file and nothing else, so the spec must carry every decision the discussion settled. Ask for that first, in the session that holds the discussion:

```bash
aldev code resume <sessionId> --message "Ensure this spec is self-sufficient: another session will write the plans from it."
```

Then start the planning session, naming the spec so the coder does not have to guess among the ticket's files:

```bash
aldev code new --protocol plan --ticket AB-123 --message "spec: \`.plans/AB-123/A1-spec.md\`"
```

Either way the coder writes the plan file, or several sub-plans and a main plan for large work.

Plan files are the coder's material: never read one, main plans included. When the user hands you a plan to execute, pass its path in the message as-is; for context, read the spec that shares the plan's leading letter in the same directory (`A1-spec.md` for `A2-plan.md`), when there is one.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The coder investigates, discusses, then implements in one session.

```bash
aldev code new --protocol aad --ticket AB-123 --message "Task description"
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

1. **Review** — `aldev code new --protocol review --ticket AB-123`. The coder reviews the current branch against the base branch and writes a review file; its path is in the run's result. The base defaults to the repository's default branch; override it via `--message "Base branch: \`develop\`"`. Retain the session id.
   - **Follow up** (someone else's branch, its author pushed fixes) — `aldev code resume <sessionId> --message "Fixes have been pushed, please check."`, in the review session, with the author's replies to the review appended when there are any. The coder checks its findings against the new commits and reports which are resolved and which remain. A new review session would start over.
2. **Fix** (optional, always in a fresh session — never in the review session) — `aldev code new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"`. Point the message at wherever the review lives: the review file, or the PR/MR whose comments carry it. The coder proposes fixes; decide together what to fix, as in any AAD session. Keep it simple and avoid overengineering. When the coder asks about scope, welcome expansion that cleans things up and refuse expansion that adds complexity; simplicity wins. The coder then implements and writes a summary file.

Skip the fix step when the review is informational.

## Catch up on a ticket

`--catchup` gives a new session the ticket's history (requests, specs, reviews, summaries) before the protocol and message. Use it when the ticket has prior work, for a status synthesis, or to start AAD or spec on an existing ticket:

```bash
aldev code new --ticket AB-123 --catchup                  # short synthesis of the history
aldev code new --ticket AB-123 --catchup --protocol aad --message-file - <<'ALDEV_MESSAGE'
Investigate `someFunction()` and the literal expression $(example).
ALDEV_MESSAGE
```

Prefer `--message-file` for long or multi-line messages. A quoted heredoc delimiter keeps quotes, backticks and dollar signs literal in Bash.

## Other protocols

- **description** — `aldev code new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **review** — see the review workflow above.
- **merge** — `aldev code new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering the coder's questions

During spec and AAD sessions the coder asks questions before proceeding. Resume **without a protocol** to answer. Compose the answers in English, all questions in one message, numbered to match:

```bash
aldev code resume <sessionId> --message \
  "1 - Explore the codebase and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - Yes, it should be optional."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the coder to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the elegant, proper, simple yet robust solution?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the coder to explore first. Escalate only when the question truly cannot be answered from the codebase.
