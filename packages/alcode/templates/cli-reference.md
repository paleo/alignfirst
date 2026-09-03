## CLI reference

```
alcode new --protocol <protocol> (--ticket <id> | --no-ticket) [--message "..."]
alcode new --message "..."
alcode resume <sessionId> [--protocol <protocol>] [--message "..."]
alcode status <session-file>
alcode usage
alcode projects <subcommand>
```

| Command | Description |
|---------|-------------|
| `new` | Start a new session. |
| `resume <sessionId>` | Continue an existing session. |
| `status <session-file>` | Reconcile and show one run's durable status. The path must be under `.plans/**/_alcode/`. Does not start a coding agent. |
| `usage` | Show the selected coding agent's current usage limits and reset times. Takes no option. |
| `projects` | Discover and manage the projects of a projects directory; run `alcode projects --guide` before project lifecycle work. |

| Option | Description |
|--------|-------------|
| `--protocol <p>` | One of `spec`, `plan`, `aad`, `description`, `catchup`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. `new --protocol` requires it, or `--no-ticket`. |
| `--no-ticket` | Work without a ticket: `alcode` reserves the next side ticket through `alignfirst ticket --side` and passes it to the agent. `new` only, with a protocol. The reserved id is in the session file's path and `ticket:` frontmatter; pass it as `--ticket side-N` in later runs. |
| `--message "..."` | Message to send, written in English. `-m` is the short form. Required for `spec`, `aad`, and when no `--protocol`. |
| `--model <model>` | One of {{MODELS}}. Prefer the default model (omit the flag). |
| `--meta "..."` | Opaque handoff string stored verbatim in the session file's `meta:` frontmatter. `alcode` never reads it — it's for you to stash context the run's later reader needs (e.g. where to report the outcome). |

The current coding agent is `{{AGENT}}`. `ALIGNFIRST_CODE_MODELS` replaces its displayed allowlist. Codex aliases `sol`, `terra`, and `luna` resolve to the newest bundled matching slug only when selected; a configured full slug passes through unchanged.

`alcode status <session-file>` checks that a `running` process still owns its recorded pid. A dead run is sealed as `status: failed`, `exitReason: terminated` before the command reports it. `alcode usage` works without a `.plans` directory and does not start a coding session. Its output follows the selected agent's available account limits.

`alcode` requires the `alignfirst` CLI on `PATH`. The delegated agent runs `alignfirst guide <protocol>` in the project, so the protocols come from the installed CLI.

{{PERMISSIONS}}.

For `new` runs, the `Session ID:` is printed to stdout and written with `agent: {{AGENT}}` in the session file frontmatter. Save it to resume the conversation later. Resume requires the same selected agent; agentless legacy sessions require a new session.

**No protocol:** the message is sent as-is (no AlignFirst command). Use it to answer the agent's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
alcode resume <sessionId> --message "Your answer"
alcode new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `new` and no protocol, the agent will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default workflow. Always start with it, except for very insignificant tasks.

For large work, do not rush. Decompose it yourself only when the concerns are truly distinct; otherwise write one big spec, iterate on discussing it with the agent, then translate it into one or several plans.

1. **Spec** — `alcode new --protocol spec --ticket AB-123 --message "Feature description"`. The agent investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — `alcode resume <sessionId> --protocol plan`. The agent writes the plan file, or several sub-plans and a main plan for large work.
3. **Execute** — `alcode new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The agent implements and writes a summary file. Given a main plan, it spawns one subagent per sub-plan and writes a main summary; when the working tree is clean, append to the message: *"Feel free to commit between each plan."*
4. **Commit** — use the suggested commit message from the spec file.

Run the chain end to end. The plan is a step of the implementation, not a checkpoint for your user to clear: the moment it's written, launch the execution.

Plan files are the executing agent's material: never read one, main plans included. When the user hands you a plan to execute, pass its path in the message as-is; for context, read the spec that shares the plan's leading letter in the same directory (`A1-spec.md` for `A2-plan.md`), when there is one.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements in one session.

```bash
alcode new --protocol aad --ticket AB-123 --message "Task description"
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

1. **Review** — `alcode new --protocol review --ticket AB-123`. The agent reviews the current branch against the base branch and writes a review file; its path is in the run's result. The base defaults to the repository's default branch; override it via `--message "Base branch: \`develop\`"`.
2. **Fix** (optional, always in a fresh session — never in the review session) — `alcode new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"`. Point the message at wherever the review lives: the review file, or the PR/MR whose comments carry it. The agent proposes fixes; decide together what to fix, as in any AAD session. Keep it simple and avoid overengineering. When the agent asks about scope, welcome expansion that cleans things up and refuse expansion that adds complexity; simplicity wins. The agent then implements and writes a summary file.

Skip the fix step when the review is informational.

## Other protocols

- **description** — `alcode new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **catchup** — `alcode new --protocol catchup --ticket AB-123 [--message "..."]`. Loads the ticket's history from its requests, specs, and summaries and returns a synthesis. To continue the ticket with that history in context, run `alcode resume <sessionId> --protocol aad --message "..."` (or `--protocol spec`) in the same session. Runs are sequential, so the one-protocol-at-a-time rule still holds.
- **review** — see the review workflow above.
- **merge** — `alcode new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering agent questions

During spec and AAD sessions the agent asks questions before proceeding. Resume **without a protocol** to answer. Compose the answers in English, all questions in one message, numbered to match:

```bash
alcode resume <sessionId> --message \
  "1 - Explore the codebase and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - Yes, it should be optional."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the agent to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the elegant, proper, simple yet robust solution?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the agent to explore first. Escalate only when the question truly cannot be answered from the codebase.
