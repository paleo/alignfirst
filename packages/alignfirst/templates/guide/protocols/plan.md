# Planning Protocol

## Prerequisites

You need:

- the TICKET_DIR and ticket directory context — run `{{TICKET_CMD}}` once (`{{CMD}} ticket --side` for a side ticket, when there is no ticket)
- a **spec file** in the TICKET_DIR

Without a spec file, stop and ask the user.

## Phases

Read the spec file entirely before starting. Then plan in six phases, in this order:

1. **Investigation**: explore the codebase and check the spec against it.
2. **Analysis**: decide the plan structure, single or multiple, and collect the documentation and skills.
3. **Plan Design**: design each plan.
4. **Main Plan Design**: with multiple plans, design the main plan that coordinates them.
5. **Writing**: write the plan files.
6. **Review**: reread the plans critically and improve them.

One rule holds across all phases: an important design decision the spec leaves open, or a spec that is wrong or contradicts the code, stops the protocol. Ask the user. A plan is executed by an agent that trusts it, often while the user is away.

## Phase 1. Investigation

Your context lists the available **documentation** and **skills**. Read every document and skill that applies to any aspect of the task, and the relevant references of each skill. A familiar-looking task tempts you to skip this reading; the project conventions live in these files.

Find the relevant source code. Take the time to understand how it works today and what has to change.

The spec is the starting point, and it was written against an earlier state of the code. Verify each statement against the current implementation.

For each operation in the spec, search for an existing function that does a similar job.

## Phase 2. Analysis

### 2.1 Assess Work Scopes

Prefer a single plan when the work fits one session, especially when it stays within one area.

Split complex work into specialized plans, coordinated by a main plan. Split along:

- **Distinct logical units**: separate features or modules, each large enough to stand alone
- **Stack boundaries**: different technologies or specialization areas. The descriptions of custom agents, when some are defined, help find these boundaries.

Each specialized plan produces a coherent deliverable.

### 2.2 Identify Relevant Documentation and Skills

List the documentation and skills the implementing agent must read and follow. Exclude `alignfirst` from the skills. For a skill with reference files, name the files to load. Omit the list when nothing applies.

## Phase 3. Plan Design

Design each plan from the spec. Reuse the parts of the spec that are detailed enough, and add what the spec lacks: implementation details, file paths, a breakdown into steps.

### 3.1 Plan Content Guidelines

These guidelines apply to every plan, single or specialized.

The plan is a **self-explanatory prompt** for the coding agent. That agent starts from zero: tell it what you discovered.

- Give context: how it works today, and how it will work after the task.
- In a "Prerequisites" section, list the relevant documentation and skills. Do not repeat their content.
- Give a way to find the **important source files**: file paths, or a function name to search for. Line numbers are fine in a plan.
- Give **numbered steps**.
- List the **existing functions to reuse or refactor**. Plan thin wrappers, not re-implementations: each operation has one proper place.
- Plan a clean break. Unused code is removed. Backward compatibility appears only when the user asked for it.
- **Tests**: look first for existing tests of the kind you consider. Plan tests only when they fit the project's test setup.
- Leave out sections that add no actionable information: "Benefits", "Code Style Compliance", "Rationale", and the like.

### 3.2 Single Plan Format

_Use this when writing a single plan. Skip this section for multiple plans._

A single plan has no header with assignment, documentation, or skills. They are listed in the Prerequisites section within the plan body.

### 3.3 Specialized Plan Format

_Use this when writing multiple plans. Skip this section for a single plan._

**At the top of each specialized plan**, add a header. Include only the fields that have content. One agent can be assigned to several plans, as separate instances.

_Note: "Custom agent" refers to configured agent profiles in your environment (custom agents in Copilot, custom subagents in Claude Code). Ignore the "Assigned to" field when your environment has none._

Example:

```markdown
# Specialized Plan - [Short Title Here]

- **Assigned to**: `agent-name`
- **Documentation**:
  - `docs/topic-a/relevant-doc.md`
  - `docs/topic-b/other-doc.md`
- **Skills**: `skill-a`, `skill-b`
```

**In the context section**, explain what you discovered **within this plan's scope**: how it works today and how it will work after the task.

**In the numbered steps**, include only this plan's work. Each plan is self-contained.

**Coordination notes**: when this plan depends on another plan, say so explicitly.

### 3.4 Add a Final Step to Plans

For every plan, single or specialized, add a final step named "Write a Handover Document" with this content:

```markdown
Write a **handover document** for your teammates. List every file you updated, then summarize the changes very concisely. Keep only what helps a teammate understand what is new; leave out the obvious. When there is nothing to explain, explain nothing. Create its path by replacing the final `.md` in `{PLAN_FILE_PATH}` with `.summary.md`, then write the handover there. Ignore lint errors (formatting issues) in this file. At the end, give the path of this handover file to the user.
```

Note:

- This is a regular step, numbered like the others. A plan with 5 steps gets this one as step 6.
- Replace "{PLAN_FILE_PATH}" with the complete plan file path, such as `.plans/123/A2-plan-backend.md`. Its handover path is `.plans/123/A2-plan-backend.summary.md`.

### 3.5 Common Footer for All Plans

Add the following content to the very end of each plan:

```markdown
---

Do not trust this plan blindly. Be sure you understand the codebase and the plan by yourself before applying it.

Do not use external search tools (Context7, web search, documentation fetching) during implementation unless this plan explicitly allows it. Everything needed is in this plan or discoverable in the codebase.
```

## Phase 4. Main Plan Design

**Create a main plan only when there are several plans. Skip this section otherwise.**

### 4.1 Main Plan Guidelines

The main plan coordinates the execution of the specialized plans. It contains:

1. **Reference to the specification**: mention the spec file; do not repeat its content.
2. **Execution strategy** section: parallel or sequential, with the dependencies stated.
3. **Plan assignments** section: for each specialized plan, the applicable fields only: assignment, documentation, skills, and a brief description.
4. **Main Handover Document** section.

Format example:

````markdown
# Main Plan - [Short Title Here]

This main plan coordinates the implementation of [reference spec file].

## Execution Strategy

**Parallel execution possible**: Plans A3, A4, and A5 are independent and can be executed simultaneously.

OR

**Sequential execution required**: A3 must complete before A4 (A4 depends on API endpoints from A3).

## Plan Assignments

Execute these specialized plans:

1. **Plan A** (`A3-plan-xxx.md`)
   - **Assigned to**: `agent-name`
   - **Documentation**:
     - `docs/topic-a/doc-1.md`
     - `docs/topic-b/doc-2.md`
   - **Skills**: `skill-a`, `skill-b`
   - **Description**: [Brief description]

2. **Plan B** (`A4-plan-yyy.md`)
   - **Documentation**:
     - `docs/topic-b/doc-3.md`
   - **Description**: [Brief description]

_In the prompt given to the subagent tool, provide the file path of the specialized plan. Do not reproduce its content._

### Coordination Notes

[Any important notes about how the plans interact, if applicable]

## Main Handover Document

Write a **main plan handover document**. This document:

1. References each specialized plan's handover file
2. For each referenced handover, states "Completed" when the plan was executed successfully, and details any issue encountered otherwise

Keep this handover very short. Do not combine or repeat the content of individual handovers. Create its path by replacing the final `.md` in `{PLAN_FILE_PATH}` with `.summary.md`, then write the handover there. Ignore lint errors (formatting issues) in this file.

---

Do not trust this plan blindly. Be sure you understand the codebase and all specialized plans before coordinating their execution.

Do not use external search tools (Context7, web search, documentation fetching) during implementation unless these plans explicitly allow it. Everything needed is in these plans or discoverable in the codebase.
````

Note:

- Replace "{PLAN_FILE_PATH}" with the complete plan file path, such as `.plans/123/A2-main-plan.md`. Its handover path is `.plans/123/A2-main-plan.summary.md`.

## Phase 5. Writing

Continue the current cycle. Request the file names with `{{TICKET_CMD}} --next`, then write every file it named before requesting anything else. Append each name to TICKET_DIR to get its path. Never overwrite an existing file.

**Single plan**: run `{{TICKET_CMD}} --next plan.md`.

- Plan: `{TICKET_DIR}{CYCLE_LETTER}{FILE_NUMBER}-plan.md`, e.g. `.plans/123/A2-plan.md`
- Handover: `.plans/123/A2-plan.summary.md`

**Multiple plans**: run one command with a `--next` per file, the main plan first, then the specialized plans in the order the main plan lists them. The command returns all the names, numbered in that order, so the main plan can reference the specialized plans exactly. Example:

```
{{TICKET_CMD}} --next main-plan.md --next plan-api.md --next plan-ui.md
```

- Main plan: `{TICKET_DIR}{CYCLE_LETTER}{FILE_NUMBER}-main-plan.md`, e.g. `.plans/123/A2-main-plan.md`
- Specialized plans: `{TICKET_DIR}{CYCLE_LETTER}{FILE_NUMBER}-plan-{DESCRIPTOR}.md`, e.g. `.plans/123/A3-plan-api.md`, `.plans/123/A4-plan-ui.md`. The descriptor is lowercase and hyphenated and names the work scope or stack area.
- Handovers: replace the final `.md` with `.summary.md`, e.g. `.plans/123/A3-plan-api.summary.md`. The main plan handover is written after all specialized plans complete.

Ignore Markdown lint errors in the plan files. Fixing them wastes the session.

## Phase 6. Review

When you think the plans are complete, read them again with a critical eye and edit them to improve them. Repeat until every plan is solid.

**Additional review for multiple plans**:

- Each specialized plan is self-contained
- Each specialized plan header includes only applicable fields (assignment, documentation, skills)
- The main plan references all specialized plans with their applicable fields
- Dependencies between plans are stated

---

At the end, give the path of the plan file to the user (for a single plan: the plan file; for multiple plans: the main plan file).
