# AlignFirst Coaching Guide

Coach a coding agent through AlignFirst protocols with the `alcoach` CLI. It wraps `claude` for non-interactive use: it invokes a protocol, streams the run to a log file, and returns the result.

**Never implement, investigate, or modify the codebase yourself while coaching. Your role is to delegate and guide the agent.**

Run `alcoach` from the root of the project you are coaching, so the agent works in the right repo. The project must contain a `.plans/` directory.

## How it runs

`alcoach` runs `claude` in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

If your run should be a background task (so you stay free while it works), let **your caller** do the backgrounding. Under OpenClaw, run `alcoach` through the `exec` tool with a disabled or generous timeout (`timeout: 0`) — OpenClaw backgrounds it automatically after a few seconds and wakes you when it exits. Do **not** poll: read the log when you are woken.

Every run writes a log under `.plans/`: `.plans/<ticket>/coding-sessions/<stamp>.md`, or `.plans/_coding-sessions/<stamp>.md` without a ticket. This log is the durable record of the run — its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome. Read it to get the result after a background run completes.

## CLI reference

```
alcoach --new --protocol <protocol> --ticket <id> [--message "..."]
alcoach --new --message "..."
alcoach --resume <sessionId> [--protocol <protocol>] [--message "..."]
```

| Flag | Description |
|------|-------------|
| `--new` | Start a new session. |
| `--resume <id>` | Continue an existing session. |
| `--protocol <p>` | One of `spec`, `plan`, `aad`, `description`, `read`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. Required with `--new` + `--protocol`. |
| `--message "..."` | Message to send. Required for `spec`, `aad`, and when no `--protocol`. |
| `--model <model>` | Model override. |

For `--new` runs, the `Session ID:` is printed to stdout and written to the log frontmatter (the durable source of truth). Save it to resume the conversation later.

**No protocol:** the message is sent as-is (no AlignFirst command). Use it to answer the agent's questions in an existing session, execute a plan in a new session, or ask a question:

```bash
alcoach --resume <sessionId> --message "Your answer"
alcoach --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

When asking a question (not executing a plan) with `--new` and no protocol, the agent will try to implement by default. End the message with a constraint: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute workflow

The default. Start here except for trivial tasks.

1. **Spec** — `alcoach --new --protocol spec --ticket AB-123 --message "Feature description"`. The agent investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — `alcoach --resume <sessionId> --protocol plan`. The agent writes the plan file.
3. **Execute** — `alcoach --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The agent implements and writes a summary file.
4. **Commit** — use the suggested commit message from the spec file.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments. The agent investigates, discusses, then implements in one session.

```bash
alcoach --new --protocol aad --ticket AB-123 --message "Task description"
```

Answer questions as in the spec flow. The agent implements and writes a summary file, which carries a suggested commit message.

## Other protocols

- **description** — `alcoach --new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **read** — `alcoach --new --protocol read --ticket AB-123 [--message "..."]`. Loads the ticket's spec and summary files into context; with a message, answers it against that context.
- **review** — `alcoach --new --protocol review --ticket AB-123`. Reviews the current branch against the base and writes a review file.
- **merge** — `alcoach --new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering agent questions

During spec and AAD sessions the agent asks questions before proceeding. Resume **without a protocol** to answer. Answer all questions in one message, numbered to match:

```bash
alcoach --resume <sessionId> --message \
  "1 - Explore the codebase and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - Yes, it should be optional."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the agent to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"What would be the most elegant way to do it?"*, *"Check if a similar pattern exists elsewhere."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the agent to explore first. Escalate only when the question truly cannot be answered from the codebase.
