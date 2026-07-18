## CLI reference

```
alcode --new --protocol <protocol> --ticket <id> [--message "..."]
alcode --new --message "..."
alcode --resume <sessionId> [--protocol <protocol>] [--message "..."]
```

| Flag | Description |
|------|-------------|
| `--new` | Start a new session. |
| `--resume <id>` | Continue an existing session. |
| `--protocol <p>` | One of `spec`, `plan`, `aad`, `description`, `read`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. Required with `--new` + `--protocol`. |
| `--message "..."` | Message to send, written in English. Required for `spec`, `aad`, and when no `--protocol`. |
| `--model <model>` | Model override. |
| `--meta "..."` | Opaque handoff string stored verbatim in the session file's `meta:` frontmatter. `alcode` never reads it — it's for you to stash context the run's later reader needs (e.g. where to report the outcome). |

For `--new` runs, the `Session ID:` is printed to stdout and written to the session file frontmatter (the durable source of truth). Save it to resume the conversation later.

**No protocol:** the message is sent as-is (no AlignFirst command). Use it to answer the agent's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
alcode --resume <sessionId> --message "Your answer"
alcode --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `--new` and no protocol, the agent will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default workflow. Always start with it, except for very insignificant tasks.

For large work, do not rush. Decompose it yourself only when the concerns are truly distinct; otherwise write one big spec, iterate on discussing it with the agent, then translate it into one or several plans.

1. **Spec** — `alcode --new --protocol spec --ticket AB-123 --message "Feature description"`. The agent investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — `alcode --resume <sessionId> --protocol plan`. The agent writes the plan file.
3. **Execute** — `alcode --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The agent implements and writes a summary file. When executing a main plan that spans several sub-plans and the working tree is clean, append to the message: *"Feel free to commit between each plan."*
4. **Commit** — use the suggested commit message from the spec file.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements in one session.

```bash
alcode --new --protocol aad --ticket AB-123 --message "Task description"
```

Answer questions as in the spec flow. The agent implements and writes a summary file, which carries a suggested commit message.

## Review workflow

Two fresh sessions: one reviews, one fixes.

1. **Review** — `alcode --new --protocol review --ticket AB-123`. The agent reviews the current branch against the base branch and writes a review file; its path is in the run's result. The base defaults to the repository's default branch; override it via `--message "Base branch: \`develop\`"`.
2. **Fix** (optional) — `alcode --new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"` (adapt the path). The agent proposes fixes; decide together what to fix, as in any AAD session, then it implements and writes a summary file.

Skip the fix step when the review is informational.

## Other protocols

- **description** — `alcode --new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **read** — `alcode --new --protocol read --ticket AB-123 [--message "..."]`. Loads the ticket's spec and summary files into context; with a message, answers it against that context.
- **review** — see the review workflow above.
- **merge** — `alcode --new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering agent questions

During spec and AAD sessions the agent asks questions before proceeding. Resume **without a protocol** to answer. Compose the answers in English, all questions in one message, numbered to match:

```bash
alcode --resume <sessionId> --message \
  "1 - Explore the codebase and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - Yes, it should be optional."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the agent to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the most elegant way to do it?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the agent to explore first. Escalate only when the question truly cannot be answered from the codebase.
