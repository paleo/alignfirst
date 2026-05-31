---
name: alignfirst-coaching
description: "Coach an AlignFirst spec-plan-execute or AAD workflow using a CLI wrapper around a coding-agent CLI. Use when orchestrating coding agents through AlignFirst protocols non-interactively."
license: CC0 1.0
compatibility: Requires Node.js and the Claude Code CLI
metadata:
  author: Paleo
  version: "0.11.0"
---

Read the *alignfirst* skill (`../alignfirst/SKILL.md`) and its `references/overview.md` if not already loaded.

**Important: Never implement anything by yourself when you act as an AlignFirst coach. Never investigate or modify the codebase directly. Your role is to delegate and guide the agent.**

# AlignFirst Coaching Guide

The CLI script is at `scripts/alignfirst-coaching.mjs` **relative to this skill directory** (the directory containing this SKILL.md file). Resolve the absolute path before running it. For example, if this file is at `/home/user/.agents/skills/alignfirst-coaching/SKILL.md`, the script is at `/home/user/.agents/skills/alignfirst-coaching/scripts/alignfirst-coaching.mjs`.

The script wraps a coding-agent CLI (currently `claude`) for non-interactive usage. It invokes AlignFirst protocols, parses the JSON response, and outputs the relevant portion to stdout.

**Run it with your shell (the `exec`/Bash tool), from the target project's directory (`~/projects/<project>`)** so the coding agent works in the right repo. Running this CLI **is** how you delegate — never delegate through `sessions_spawn` or any sub-agent / sub-session spawn tool. Those start another gateway session, not the coding agent.

For `--new` modes, the output starts with a `Session ID:` line — save it to resume the conversation later.

## CLI Reference

```
node scripts/alignfirst-coaching.mjs --new --protocol <protocol> --ticket <id> [--message "..."]
node scripts/alignfirst-coaching.mjs --new --message "..."
node scripts/alignfirst-coaching.mjs --resume <sessionId> [--protocol <protocol>] [--message "..."]
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
node scripts/alignfirst-coaching.mjs --resume <sessionId> --message "Your answer"
node scripts/alignfirst-coaching.mjs --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
node scripts/alignfirst-coaching.mjs --new --message "Explain how ... works in this project. Do not implement anything. We need to talk first."
```

**Important:** When using `--new` without a protocol for a question or discussion (not plan execution), the agent is a coding agent and will try to implement things by default. End your message with a clear constraint, e.g.: *"Do not implement anything. We need to talk first."*

## Spec-Plan-Execute Workflow

The default workflow. Always start with it, except for very insignificant tasks.

### Step 1 — Create a spec

```bash
node scripts/alignfirst-coaching.mjs --new --protocol spec --ticket AB-123 --message "Description of the feature or task"
```

The agent investigates the codebase and responds with its findings and questions. Save the session ID from the output. There may be several back-and-forths before the agent is satisfied and writes the spec file — see [Answering agent questions](#answering-agent-questions).

### Step 2 — Request a plan

Once the spec is written, request a plan in the same session:

```bash
node scripts/alignfirst-coaching.mjs --resume <sessionId> --protocol plan
```

The agent writes a plan file (e.g. `.plans/AB-123/A2-plan.md`) and provides its path in the output. The agent rarely asks questions at this stage.

### Step 3 — Execute the plan

Start a **new** session to execute the plan:

```bash
node scripts/alignfirst-coaching.mjs --new --message "Execute the plan: \`.plans/AB-123/A2-plan.md\`"
```

The agent implements the plan and writes a summary file (e.g. `.plans/AB-123/A2-plan.summary.md`), providing its path in the output.

### Step 4 — Commit

The spec file contains a suggested commit message near the top. Use it to commit the changes locally.

## Light Workflow (AAD)

For straightforward changes that can be done in one shot — like moving a button or tweaking a color — or for follow-up adjustments right after executing a plan. The agent investigates, discusses, then implements directly — all in one session.

### Step 1 — Start an AAD session

```bash
node scripts/alignfirst-coaching.mjs --new --protocol aad --ticket AB-123 --message "Description of the task"
```

Like the spec workflow, the agent investigates the codebase and asks questions. Save the session ID. Answer questions the same way — see [Answering agent questions](#answering-agent-questions).

Once aligned, the agent implements the changes and writes a summary file (e.g. `.plans/AB-123/A1-AAD.summary.md`), providing its path in the output.

### Step 2 — Commit

The summary file contains a suggested commit message. Commit locally as in the spec workflow.

## Description

Generates a PR/MR description for work already committed. No discussion — the agent reads the changes and writes a description file.

```bash
node scripts/alignfirst-coaching.mjs --new --protocol description --ticket AB-123
```

The agent writes a markdown file with the description and provides its path in the output.

## Read (Load Context)

Loads the spec and summary files for a ticket into the agent's context. Without `--message`, the agent describes what was done for the ticket. With `--message`, it loads context then processes the message in a single call — useful to ask questions about prior work.

```bash
node scripts/alignfirst-coaching.mjs --new --protocol read --ticket AB-123
node scripts/alignfirst-coaching.mjs --new --protocol read --ticket AB-123 --message "Did we propagate the changes in ...? Do not implement anything. We need to talk first."
```

## Review (Code Review)

Reviews the current branch against the base branch and writes a review report.

```bash
node scripts/alignfirst-coaching.mjs --new --protocol review --ticket AB-123
```

The agent writes a review file (e.g. `.plans/AB-123/A3-review.md`) and provides its path in the output.

## Merge

Resolves merge or rebase conflicts and summarizes the tricky resolutions. Can also start the merge when given an incoming branch.

When conflicts are already present:

```bash
node scripts/alignfirst-coaching.mjs --new --protocol merge --ticket AB-123
```

When the merge has not started, pass the incoming branch via `--message`:

```bash
node scripts/alignfirst-coaching.mjs --new --protocol merge --ticket AB-123 --message "Merge \`main\` into the current branch."
```

On conflicts, the agent writes a summary file (e.g. `.plans/AB-123/A4-merge.summary.md`) and provides its path. On a clean merge, no summary is written.

## Answering Agent Questions

During spec and AAD sessions, the agent asks questions before proceeding. Resume the session **without a protocol** to answer:

```bash
node scripts/alignfirst-coaching.mjs --resume <sessionId> --message "Your answer here"
```

There may be several back-and-forths before the agent is satisfied.

The agent often asks multiple questions at once. Answer them all in a single message, numbered to match:

```bash
node scripts/alignfirst-coaching.mjs --resume <sessionId> --message \
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
