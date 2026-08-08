# AlignFirst Overview

AlignFirst is a set of collaborative protocols for working with a user on coding tasks. The two workflows involve **alignment with the user** — investigating, discussing, and agreeing before acting.

## Workflows

### Spec-Plan-Execute (default)

The standard workflow for most tasks. It produces formal artifacts at each stage:

1. **Spec** (`/alspec`): Investigate the codebase, discuss with the user, then write a technical specification. There are usually several back-and-forths before the spec is written.
2. **Plan** (`/alplan`): Read the spec, investigate further, then write implementation plan(s). The plan is a self-contained prompt for the implementing agent.
3. **Execute**: A new session implements the plan and writes a handover document summarizing the changes.

After execution, additional rounds of AAD (see below) can address follow-up fixes or adjustments.

### AAD — Align-and-Do (light)

For smaller tasks that don't justify a formal spec and plan. Everything happens in one session: investigate, discuss, implement, summarize.

Use AAD (`/al`) when:

- The task is small or well-understood
- It's a follow-up change after a plan has already been executed
- A quick fix or adjustment is needed

Use Spec-Plan-Execute when:

- The task is non-trivial or touches multiple areas
- There are open design questions that need formal exploration
- You're unsure — default to Spec-Plan-Execute

## Description

A standalone utility (`/aldescription`). It reads specs and summaries that have been generated for a ticket and produces a concise description of what was implemented. Typically used to generate a PR/MR description once the work is done.

## Code Review

A standalone utility (`/alreview`). It compares the current branch to a base branch (defaults to the repo's default branch) and runs parallel reviewers, each with its own perspective: intent, correctness, change safety, code quality. Ecosystem modules (strict TypeScript, JavaScript, Python) sharpen the language-specific checks. The findings are merged into a concise review report.

## Merge

A standalone utility (`/almerge`). After a merge or rebase, the agent investigates both sides, resolves the conflicts (with a special case for lock files), and writes a brief summary of the resolutions.

## Typical Lifecycle of a Ticket

A ticket usually progresses through:

1. **Spec** — explore and formalize what needs to be done
2. **Plan** — design how to do it
3. **Execute** — implement the plan
4. _(optional)_ **AAD** — address follow-up fixes or small adjustments
5. **Description** — summarize the implemented work
