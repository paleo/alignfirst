# AlignFirst Delegation Guide{{TITLE-SUFFIX}}

Run a coding agent through AlignFirst protocols with the `alcode` CLI. It wraps a coding-agent CLI for non-interactive use: it invokes a protocol, streams the run to a session file, and returns the result.

**Never implement, investigate, or modify the codebase yourself while delegating. Your role is to delegate and guide the agent.**

Run `alcode` from the root of the target project, so the agent works in the right repo. The project must contain a `.plans/` directory.

## How it runs

`alcode` runs the coding agent in the **foreground** and blocks until it finishes, streaming the transcript to stdout as it arrives. It never backgrounds or detaches itself.

Coding runs can be long (several hours is fine): **always run `alcode` as a background task**, so you stay free while it works. The backgrounding is **your platform's** job, never alcode's own.

{{RUN}}

As soon as the run is backgrounded, tell the user the coding agent is now working in the background and that you will report back when it finishes (e.g. *"Le coding agent tourne en arrière-plan — je te préviens dès que c'est terminé."*). Then go available. Do **not** poll.

Every run writes a session file under `.plans/`: `.plans/<ticket>/coding-sessions/<stamp>.md`, or `.plans/_coding-sessions/<stamp>.md` without a ticket. This file is the durable record of the run. Its frontmatter carries `status` (`running` → `succeeded`/`failed`) and the `sessionId`, and the `---- Result ----` block holds the outcome.

## After a background run completes

{{WAKE}}

1. **Read the run's session file** (the path `alcode` printed on its first line, under `coding-sessions/`). Its frontmatter holds `status` (`succeeded` / `failed`) and the session id; the `---- Result ----` block holds the outcome. If you set `meta` at launch, it is there too.
2. **Report the outcome to the user** where the work was requested. Send one concise message: succeeded or failed, plus a one-line summary of the result for the audience. If the frontmatter `meta` carries a destination (e.g. a thread target), route this report there — a plain reply from the wake turn goes to the session's default surface, which may not be where the work was requested.
3. Do **not** re-verify the repo, re-run the coding agent, fetch/merge branches, or inspect `git`. The coding agent already did the work and the session file is authoritative. Relay its outcome, nothing more.

If the session file says the run failed, report that plainly and propose the next step; don't silently retry.

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
| `--message "..."` | Message to send. Required for `spec`, `aad`, and when no `--protocol`. |
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

1. **Spec** — `alcode --new --protocol spec --ticket AB-123 --message "Feature description"`. The agent investigates and asks questions; save the session id. Iterate until it writes the spec file.
2. **Plan** — `alcode --resume <sessionId> --protocol plan`. The agent writes the plan file.
3. **Execute** — `alcode --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"`. The agent implements and writes a summary file.
4. **Commit** — use the suggested commit message from the spec file.

## Light workflow (AAD)

For one-shot changes or follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements in one session.

```bash
alcode --new --protocol aad --ticket AB-123 --message "Task description"
```

Answer questions as in the spec flow. The agent implements and writes a summary file, which carries a suggested commit message.

## Other protocols

- **description** — `alcode --new --protocol description --ticket AB-123`. Writes a PR/MR description for committed work. No discussion.
- **read** — `alcode --new --protocol read --ticket AB-123 [--message "..."]`. Loads the ticket's spec and summary files into context; with a message, answers it against that context.
- **review** — `alcode --new --protocol review --ticket AB-123`. Reviews the current branch against the base and writes a review file.
- **merge** — `alcode --new --protocol merge --ticket AB-123`. Resolves conflicts and summarizes tricky resolutions. Pass the incoming branch via `--message` to start the merge.

## Answering agent questions

During spec and AAD sessions the agent asks questions before proceeding. Resume **without a protocol** to answer. Answer all questions in one message, numbered to match:

```bash
alcode --resume <sessionId> --message \
  "1 - Explore the codebase and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - Yes, it should be optional."
```

**Technical questions** — architecture, patterns, existing behavior, anything answerable by reading the code. Never escalate these to the user. Push the agent to investigate: *"Explore the codebase to find out, and give me your opinion."*, *"Do not rush. Take the time to fully understand the situation first."*, *"What would be the most elegant way to do it?"*, *"Check if a similar pattern is already implemented elsewhere in the codebase."*

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These need human judgement: escalate to your user, then relay the answer.

When in doubt, ask the agent to explore first. Escalate only when the question truly cannot be answered from the codebase.
