---
name: alignfirst-coaching
description: "Coach an AlignFirst spec-plan-execute or AAD workflow using a CLI wrapper around the claude command. Use when orchestrating coding agents through AlignFirst protocols non-interactively."
license: CC0 1.0
compatibility: Requires Node.js and the claude CLI
metadata:
  author: Paleo
  version: "0.1.0"
  repository: https://github.com/paleo/alignfirst
---

Read the *alignfirst* skill (`../alignfirst/SKILL.md`) and its `references/overview.md` before doing anything else.

**Important: Never implement anything by yourself when you act as an AlignFirst coach. Never investigate or modify the codebase directly. Your role is to delegate and guide the agent.**

# AlignFirst Coaching Guide

`scripts/alignfirst-agent.mjs` wraps the `claude` CLI for non-interactive usage. It invokes AlignFirst protocols (`/alspec`, `/alplan`, etc.), parses the JSON response, and outputs the relevant portion to stdout.

For `--new` modes, the output starts with a `Session ID:` line — save it to resume the conversation later.

## Spec-Plan-Execute Workflow

The default workflow. Always start with it, except for very insignificant tasks.

### Step 1 — Create a spec

```bash
node scripts/alignfirst-agent.mjs --new --ticket AB-123 --spec --message "Description of the feature or task"
```

The agent investigates the codebase and responds with its findings and questions. Save the session ID from the output. There may be several back-and-forths before the agent is satisfied and writes the spec file — see [Answering agent questions](#answering-agent-questions).

### Step 2 — Request a plan

Once the spec is written, request a plan in the same session:

```bash
node scripts/alignfirst-agent.mjs --resume <sessionId> --plan
```

The agent writes a plan file (e.g. `.plans/AB-123/the-new-plan.md`) and provides its path in the output. The agent rarely asks questions at this stage.

### Step 3 — Execute the plan

Start a **new** session to execute the plan:

```bash
node scripts/alignfirst-agent.mjs --new --message "Execute the plan: \`.plans/AB-123/the-new-plan.md\`"
```

The agent implements the plan and writes a summary file (e.g. `.plans/AB-123/the-new-plan.summary.md`), providing its path in the output.

### Step 4 — Commit

The spec file contains a suggested commit message near the top. Use it to commit the changes locally.

## Light Workflow (AAD)

For smaller tasks that don't need a formal spec and plan. The agent investigates, discusses, then implements directly — all in one session. Often used for follow-up changes after a plan has been executed.

### Step 1 — Start an AAD session

```bash
node scripts/alignfirst-agent.mjs --new --ticket AB-123 --aad --message "Description of the task"
```

Like the spec workflow, the agent investigates the codebase and asks questions. Save the session ID. Answer questions the same way — see [Answering agent questions](#answering-agent-questions).

Once aligned, the agent implements the changes and writes a summary file (e.g. `.plans/AB-123/A1-AAD.summary.md`), providing its path in the output.

### Step 2 — Commit

The summary file contains a suggested commit message. Commit locally as in the spec workflow.

## Description

Generates a PR/MR description for work already committed. No discussion — the agent reads the changes and writes a description file.

```bash
node scripts/alignfirst-agent.mjs --new --ticket AB-123 --description
```

The agent writes a markdown file with the description and provides its path in the output.

## Answering Agent Questions

During spec and AAD sessions, the agent asks questions before proceeding. Resume the session to answer:

```bash
node scripts/alignfirst-agent.mjs --resume <sessionId> --message "Your answer here"
```

There may be several back-and-forths before the agent is satisfied.

**When the agent asks a technical question** (architecture, code patterns, existing behavior): ask it to explore the codebase and form its own opinion.

```bash
node scripts/alignfirst-agent.mjs --resume <sessionId> --message \
  "Explore the codebase to find out, and give me your opinion."
```

**When the agent asks a functional or UX question** (product behavior, user-facing details, business rules): these require human judgement. Escalate to your user or product owner, then relay their answer.

```bash
node scripts/alignfirst-agent.mjs --resume <sessionId> --message \
  "We checked with the team: the answer is ..."
```

## Environment Variables

- `ALIGNFIRST_AGENT_LOG_DIR` — If set, the script writes input/output logs to this directory.
- `ALIGNFIRST_AGENT_AUTO_APPROVE` — If set, uses `--dangerously-skip-permissions` instead of `--permission-mode auto`.
