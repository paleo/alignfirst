# How to Write Implementation Plans

## Pre-requisites

### Determine TASK_DIR, CYCLE_LETTER, and FILE_NUMBER

You need:

- the TASK_DIR - if you don't have it, use your instructions on finding the **ticket ID**, or ask the user
- the current CYCLE_LETTER and the bumped FILE_NUMBER - deduce them yourself.
- a **spec file** in the `_plans/{TASK_DIR}/` directory

Identify and state these values before starting the protocol. If any of these pieces of information is missing, STOP AND ASK THE USER.

## Phases

Before starting, **read the spec file** and understand it entirely.

In order to generate implementation plans, you MUST follow this process:

1. **Investigation Phase**: Explore the codebase, understand the current implementation, and identify the problem
2. **Analysis Phase**: Determine the plan structure (single or multiple plans) and identify relevant skills
3. **Designing Phase - Implementation Plan(s)**: Design plan(s) based on the analysis - If you discover issues or missing design decisions, STOP AND ASK THE USER
4. **Designing Phase - Orchestrator Plan**: If multiple plans, design an orchestrator plan to coordinate them
5. **Writing Phase**: Write the plan file(s)
6. **Review Phase**: Critically review and improve the plan(s)

## Phase 1. Investigation Phase

Investigate the codebase yourself, find the relevant source code, think carefully, take the time to understand how it currently works and what has to be done.

Use the SPEC text as a starting point, but do not trust it blindly. Verify the current implementation and ensure the spec is still accurate. If you discover that an important design choice still needs to be made, or if the spec has issues, STOP AND ASK THE USER.

For each operation in the spec, search for existing functions that do a similar job.

## Phase 2. Analysis Phase

Based on your investigation, determine the plan structure:

### 2.1 Assess Work Scope

First, evaluate if the work should be split into **multiple sub-plans**:

- **Single plan**: Preferred when work is cohesive within one area AND small enough to be manageable, or when cross-stack work is small and simple
- **Multiple plans**: Split into multiple plans with an orchestrator, based on:
  - **Stack boundaries**: Different technologies or specialization areas
  - **Distinct logical units**: Separate features or modules within the same stack, when large enough
  - Each sub-plan should produce a **coherent, testable deliverable**

### 2.2 Identify Relevant Skills

For each plan, identify which **skills** are relevant:

- List the skills that the implementing agent should read and follow
- Skills provide domain-specific guidelines that must be followed during implementation
- For complex skills with reference files, identify specific files that should be loaded

### 2.3 Assign Custom Agents (Optional)

If **Custom Agents** are defined in the project, assign each plan to the appropriate agent based on their specialization. Otherwise, skip this step.

Multiple instances: The same custom agent can be assigned to multiple plans. Each plan runs in a separate custom agent instance, so don't group unrelated work into one plan just because it would use the same custom agent. Split by logical unit, not by custom agent.

## Phase 3. Designing Phase - Implementation Plan Structure

Design an implementation plan based on the SPEC. Include all useful information from the spec. If the spec is already detailed enough, you can extract and reuse parts of it. Add implementation details, file paths, and a breakdown into steps that weren't in the spec.

### 3.1 Common Plan Guidelines

**These guidelines apply to all plans (single plan or specialized plans).**

Follow these guidelines:

- The plan must be a **self-explanatory prompt** for the coding agent, so help it by explaining what you discovered that is relevant.
- Give some context: explain how it works currently, and how it will work after the task is done.
- In a "Prerequisites" section, list **relevant skills** to use. Do not repeat any skill content.
- Mention a way to find **important source files**: by giving file paths, or by providing a function name to search for, for example. If needed, line numbers can be mentioned in the plan.
- Include a list of **numbered steps**.
- **Never plan backward compatibility** unless explicitly requested. Prefer clean code. Unused code must be removed.
- About **tests**: Investigate first in the codebase if there are tests already in place for the kind of tests you consider. Do not mention to write tests unless you are sure they will be well-integrated in the project.
- Do not include sections like "Benefits", "Code Style Compliance", "Rationale" or anything that adds no actionable information. Focus on the problem and the solution.
- List **existing functions to reuse or refactor**. Plan thin wrappers, not re-implementations. Each operation should have one proper place.

### 3.2 Additional Requirements for Specialized Plans

**Use this when multiple plans are created. For a single plan, skip this section entirely.**

For specialized plans, add these additional requirements:

**At the top of each specialized plan**, add a header with assignment and skills:

```markdown
**Assigned to**: [Custom Agent Name or "Agent"]
**Skills**: [List of relevant skills for this plan]
```

**In the context section**, explain what you discovered **relevant to this plan's scope** and how it works currently and will work after the task is done **within its scope**.

**In the numbered steps**, include only steps for this plan's work. Each plan should be self-contained.

**Coordination notes**: If this plan depends on another plan, mention it explicitly.

### 3.3 Add a Final Step to Plans

**For single plans and specialized plans**, add a final step named "Write a Handover Document" with this content:

```markdown
Write a **handover document**. This document must contain the list of all files you updated. Also, summarize the changes made in a very concise way. Add only relevant information that will help your teammates understand what's new. Do not mention obvious information. It's not a course or a tutorial, if there is nothing to explain, then do not explain. Write this handover document in `{PLAN_FILE_PATH}.summary.md`. Avoid overwriting an existing file. Ignore lint errors (formatting issues) in this file.
```

Note:

- This is a regular step, it should be numbered like the other steps. For example, if your plan has 5 steps, this becomes step 6.
- Replace "{PLAN_FILE_PATH}" with the actual plan file path without extension (e.g., for plan `_plans/123/A2-plan-backend.md`, use `_plans/123/A2-plan-backend`, resulting in `_plans/123/A2-plan-backend.summary.md`).

### 3.4 Common Footer for All Plans

Add the following content to the very end of each plan (single plan or specialized plan):

```markdown
---

Do not trust this plan blindly. Be sure you understand the codebase and the plan by yourself before applying it.

**IMPORTANT**: Do NOT use external search tools (Context7, web search, documentation fetching) during implementation unless explicitly allowed in this plan. All context should be provided in this plan or discoverable in the codebase.
```

## Phase 4. Designing Phase - Orchestrator Plan

**Create an orchestrator plan only when multiple plans are created. Skip this section entirely if not applicable.**

### 4.1 Orchestrator Plan Guidelines

The orchestrator plan coordinates the execution of all specialized plans. It should contain:

1. **Reference to the specification**: Mention the spec file but do not repeat its content.
2. **Execution strategy**: Specify if plans can be executed in parallel or must be sequential, with dependencies clearly noted.
3. **Plan assignments**: For each specialized plan, specify:
   - Which agent should execute it (custom agent name or "Agent")
   - Which **skills** are relevant for that plan
4. **Final step**: Add a step to write an orchestrator handover (see section 4.2).

Format example:

<example_markdown>

## Execution Plan

This orchestrator coordinates the implementation of [reference spec file].

### Execution Strategy

**Parallel execution possible**: Plans A3, A4, and A5 are independent and can be executed simultaneously.

OR

**Sequential execution required**: A3 must complete before A4 (A4 depends on API endpoints from A3).

### Plan Assignments

Execute these specialized plans:

1. **Plan A** (`A3-plan-xxx.md`)
   - **Assigned to**: `custom-agent-name` or `Agent`
   - **Skills**: `skill-1`, `skill-2`
   - **Description**: [Brief description of what this plan accomplishes]

2. **Plan B** (`A4-plan-yyy.md`)
   - **Assigned to**: `custom-agent-name` or `Agent`
   - **Skills**: `skill-3`
   - **Description**: [Brief description of what this plan accomplishes]

_**Important:** In the prompt you give to the subagent, do not reproduce the specialized plan. Instead, provide the file path._

### Coordination Notes

[Any important notes about how the plans interact, if applicable]

</example_markdown>

### 4.2 Orchestrator Handover Step

Add a final step to the orchestrator plan named "Write Orchestrator Handover Document" with this content:

```markdown
Write an **orchestrator handover document**. This document should:

1. Reference each specialized plan's handover file
2. For each referenced handover:
   - State "Completed" if the plan was executed successfully
   - Detail any issues encountered during execution

Keep this handover very short. Do not combine or repeat the content of individual handovers. Write this document in `{PLAN_FILE_PATH}.summary.md`. Avoid overwriting an existing file. Ignore lint errors (formatting issues) in this file.
```

Note:

- Replace "{PLAN_FILE_PATH}" with the actual plan file path without extension (e.g., for plan `_plans/123/A2-plan-orchestrator.md`, use `_plans/123/A2-plan-orchestrator`, resulting in `_plans/123/A2-plan-orchestrator.summary.md`)

### 4.3 Footer for Orchestrator Plan

Add the following content to the very end of the orchestrator plan:

```markdown
---

Do not trust this plan blindly. Be sure you understand the codebase and all specialized plans before coordinating their execution.

**IMPORTANT**: Do NOT use external search tools (Context7, web search, documentation fetching) during implementation unless explicitly allowed in these plans. All context should be provided in these plans or discoverable in the codebase.
```

## Phase 5. Writing Phase

Write the plan file(s) according to the determined structure:

**Single Plan**:

- **Single plan**: `_plans/{TASK_DIR}/{CYCLE_LETTER}{FILE_NUMBER}-plan.md`
  - Example: `_plans/123/A2-plan.md`
  - Handover: `_plans/123/A2-plan.summary.md`
  - No orchestrator plan needed

**Multiple Plans**:

- **Orchestrator plan**: `_plans/{TASK_DIR}/{CYCLE_LETTER}{FILE_NUMBER}-plan-orchestrator.md`
  - Example: `_plans/123/A2-plan-orchestrator.md`
  - Handover: `_plans/123/A2-plan-orchestrator.summary.md` (written after all specialized plans complete)
- **Specialized plans**: `_plans/{TASK_DIR}/{CYCLE_LETTER}{FILE_NUMBER}-plan-{DESCRIPTOR}.md`
  - Use a descriptive name as `{DESCRIPTOR}` (e.g., work scope, stack area)
  - Example: `_plans/123/A3-plan-api.md`, `_plans/123/A4-plan-ui.md`
  - Handovers: `_plans/123/A3-plan-api.summary.md`, etc.

**Important**:

- Increment FILE_NUMBER for each plan file
- Use lowercase, hyphenated descriptors for plan names (work scope descriptor)
- When multiple plans are created, the orchestrator plan should be written first and have the lowest FILE_NUMBER
- Be careful never to overwrite an existing file

_Important Note: There will be lint errors in the markdown files you write. Ignore them. NEVER FIX LINT ERRORS (FORMATTING ISSUES) IN THE PLANS._

## Phase 6. Review Phase

When you think the plan(s) are complete, read them again with a critical eye, edit them to improve them.

Repeat the review until you think all plans are solid.

**Additional review for multiple plans**:

- Each specialized plan is self-contained
- Each specialized plan clearly states its assignment and relevant skills
- The orchestrator plan correctly references all specialized plans with their skills
- Dependencies between plans are clearly documented
