---
name: alignfirst-coaching
description: "Coach an AlignFirst spec-plan-execute or AAD workflow using a CLI wrapper around a coding-agent CLI. Use when orchestrating coding agents through AlignFirst protocols non-interactively."
license: CC0 1.0
compatibility: Requires Node.js, the Claude Code CLI, and the @paleo/alcode CLI
metadata:
  author: Paleo
  version: "0.14.0"
---

Read the *alignfirst* skill (`../alignfirst/SKILL.md`) and its `references/overview.md` if not already loaded.

**Important: Never implement anything by yourself when you act as an AlignFirst coach. Never investigate or modify the codebase directly. Your role is to delegate and guide the agent.**

# AlignFirst Coaching Guide

Coaching runs through the `alcode` CLI (the `@paleo/alcode` package). It wraps a coding-agent CLI (currently `claude`) for non-interactive use: it invokes an AlignFirst protocol, streams the run to a per-call session file, and returns the result.

Run `alcode` from the root of the project you're coaching, so the coding agent works in the right repo. The project must contain a `.plans/` directory. For the full reference, run `alcode --guide`.

For `--new` modes, save the `Session ID:` (surfaced in the output in foreground, or written to the session file's frontmatter) to resume the conversation later.

## How it runs — and backgrounding long runs

`alcode` runs `claude` in the **foreground** and blocks until it finishes, streaming the transcript. It never backgrounds itself.

Coaching runs are long. If you are an OpenClaw agent, run `alcode` through the `exec` tool with `timeout: 0` so it is not killed mid-run; OpenClaw backgrounds it automatically after a few seconds and wakes you when it exits. Then **do not poll** — go available, and when you are woken, read the run's session file (its path is printed on the first line and lives under `.plans/`) to get the outcome.

## CLI Reference

```
alcode --new --protocol <protocol> --ticket <id> [--message "..."]
alcode --new --message "..."
alcode --resume <sessionId> [--protocol <protocol>] [--message "..."]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--new` | Start a new session. |
| `--resume <id>` | Continue an existing session. |
| `--protocol` | One of: `spec`, `plan`, `aad`, `description`, `read`, `review`, `merge`. Optional. |
| `--ticket <id>` | Ticket ID. Required with `--new` + `--protocol`. |
| `--message "..."` | Message to send. Required for `spec`, `aad`, and when no `--protocol` is given. Optional for other protocols. |
| `--model <model>` | Optional model override. |

**Key pattern — no protocol:** When no `--protocol` is given, the message is sent as-is (no AlignFirst slash command is invoked). This is used to:
- Continue a discussion in an existing session (e.g. answering agent questions)
- Execute an existing plan file in a new session
- Ask the agent a question in a new session

```bash
alcode --resume <sessionId> --message "Your answer"
alcode --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
alcode --new --message "Explain how ... works in this project. Do not implement anything. We need to talk first."
```

**Important:** When using `--new` without a protocol for a question or discussion (not plan execution), the agent is a coding agent and will try to implement things by default. End your message with a clear constraint, e.g.: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute Workflow

The default workflow. Always start with it, except for very insignificant tasks.

### Step 1 — Create a spec

```bash
alcode --new --protocol spec --ticket AB-123 --message "Description of the feature or task"
```

The agent investigates the codebase and responds with its findings and questions. Save the session ID from the output. There may be several back-and-forths before the agent is satisfied and writes the spec file — see [Answering agent questions](#answering-agent-questions).

### Step 2 — Request a plan

Once the spec is written, request a plan in the same session:

```bash
alcode --resume <sessionId> --protocol plan
```

The agent writes a plan file (e.g. `.plans/AB-123/A2-plan.md`) and provides its path in the output. The agent rarely asks questions at this stage.

### Step 3 — Execute the plan

Start a **new** session to execute the plan:

```bash
alcode --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

The agent implements the plan and writes a summary file (e.g. `.plans/AB-123/A2-plan.summary.md`), providing its path in the output.

### Step 4 — Commit

The spec file contains a suggested commit message near the top. Use it to commit the changes locally.

## Light Workflow (AAD)

For straightforward changes that can be done in one shot — like moving a button or tweaking a color — or for follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements directly — all in one session.

### Step 1 — Start an AAD session

```bash
alcode --new --protocol aad --ticket AB-123 --message "Description of the task"
```

Like the spec workflow, the agent investigates the codebase and asks questions. Save the session ID. Answer questions the same way — see [Answering agent questions](#answering-agent-questions).

Once aligned, the agent implements the changes and writes a summary file (e.g. `.plans/AB-123/A1-AAD.summary.md`), providing its path in the output.

### Step 2 — Commit

The summary file contains a suggested commit message. Commit locally as in the spec workflow.

## Description

Generates a PR/MR description for work already committed. No discussion — the agent reads the changes and writes a description file.

```bash
alcode --new --protocol description --ticket AB-123
```

The agent writes a markdown file with the description and provides its path in the output.

## Read (Load Context)

Loads the spec and summary files for a ticket into the agent's context. Without `--message`, the agent describes what was done for the ticket. With `--message`, it loads context then processes the message in a single call — useful to ask questions about prior work.

```bash
alcode --new --protocol read --ticket AB-123
alcode --new --protocol read --ticket AB-123 --message "Did we propagate the changes in ...? Do not implement anything. We need to talk first."
```

## Review (Code Review)

Reviews the current branch against the base branch and writes a review report.

```bash
alcode --new --protocol review --ticket AB-123
```

The agent writes a review file (e.g. `.plans/AB-123/A3-review.md`) and provides its path in the output.

## Merge

Resolves merge or rebase conflicts and summarizes the tricky resolutions. Can also start the merge when given an incoming branch.

When conflicts are already present:

```bash
alcode --new --protocol merge --ticket AB-123
```

When the merge has not started, pass the incoming branch via `--message`:

```bash
alcode --new --protocol merge --ticket AB-123 --message "Merge \`main\` into the current branch."
```

On conflicts, the agent writes a summary file (e.g. `.plans/AB-123/A4-merge.summary.md`) and provides its path. On a clean merge, no summary is written.

## Answering Agent Questions

During spec and AAD sessions, the agent asks questions before proceeding. Resume the session **without a protocol** to answer:

```bash
alcode --resume <sessionId> --message "Your answer here"
```

There may be several back-and-forths before the agent is satisfied.

The agent often asks multiple questions at once. Answer them all in a single message, numbered to match:

```bash
alcode --resume <sessionId> --message \
  "1 - Explore the codebase to find out, and give me your opinion.
2 - Is that a good design? We need the cleanest code possible.
3 - We checked with the team: yes, it should be optional."
```

### Technical vs functional questions — this is critical

**Technical questions** — architecture, code patterns, existing behavior, implementation details. Anything answerable by reading the code: "Is X used elsewhere?", "How does Y work?", "Should we remove Z?", "What's the best approach for...?"

**Never escalate these to the user.** Push the agent to investigate and think for itself. Example responses:

- `"Explore the codebase to find out, and give me your opinion."`
- `"Do not rush. Take the time to fully understand the situation first."`
- `"What would be the most elegant and proper way to do it?"`
- `"Is that a good design? We need the cleanest code possible."`
- `"If it is a better design, then yes. If you're not sure, take the time to investigate more."`
- `"Check if a similar pattern is already implemented elsewhere in the codebase."`

**Functional or UX questions** — product behavior, user-facing decisions, business rules. These require human judgement. Escalate to your user, then relay their answer.

**When in doubt**, ask the agent to explore first. Only escalate to the user if the question truly cannot be answered from the codebase.
