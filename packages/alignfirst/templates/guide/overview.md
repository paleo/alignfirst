# AlignFirst Overview

AlignFirst is a set of collaborative protocols for working with a user on coding tasks. The two workflows involve **alignment with the user** — investigating, discussing, and agreeing before acting.

## Workflows

### Spec-Plan-Execute (default)

The standard workflow for most tasks. It produces formal artifacts at each stage:

1. **Spec** (`alspec` alias): Investigate the codebase, discuss with the user, then write a technical specification. There are usually several back-and-forths before the spec is written.
2. **Plan** (`alplan` alias): Read the spec, investigate further, then write implementation plan(s). The plan is a self-contained prompt for the implementing agent.
3. **Execute**: A new session implements the plan and writes a handover document summarizing the changes.

After execution, additional rounds of AAD (see below) can address follow-up fixes or adjustments.

### AAD — Align-and-Do (light)

For smaller tasks that don't justify a formal spec and plan. Everything happens in one session: investigate, discuss, implement, summarize.

Use AAD (`al` alias) when:

- The task is small or well-understood
- It's a follow-up change after a plan has already been executed
- A quick fix or adjustment is needed

Use Spec-Plan-Execute when:

- The task is non-trivial or touches multiple areas
- There are open design questions that need formal exploration
- You're unsure — default to Spec-Plan-Execute

## Catch Up

`{{CMD}} ticket --catchup` loads the ticket's history: its requests, specs, reviews and summaries, without the plans. When the history is too large, the command lists the files instead and the agent reads the relevant ones.

The `alcatchup` alias loads this context, then follows the user's instructions or returns a short synthesis. `alcatchupaad` and `alcatchupspec` load it, then start AAD or a specification.

## Standalone Utilities

Each utility runs on its own, outside the workflows.

### Description

`aldescription` alias. Reads the specs and summaries of a ticket and writes a concise description of the implemented work, typically for a PR or MR.

### Review

`alreview` alias. Compares the current branch to a base branch (the repository's default branch unless another is given) and runs parallel reviewers, each with its own perspective: intent, correctness, change safety, code quality. Ecosystem modules (strict TypeScript, JavaScript, Python) sharpen the language-specific checks. The findings are merged into a concise review report, which records the reviewed commit.

Two options come with the request. A starting commit limits the review to the commits added after it, usually since an earlier review. The light form, a single pass in place of the four reviewers, is the default for a minor change; the request can name either form.

### Merge

`almerge` alias. Merges an incoming branch, or resolves the conflicts of a merge or rebase in progress. The agent investigates both sides, resolves each conflict (with a special case for lock files), and writes a brief summary of the resolutions.

## Typical Lifecycle of a Ticket

A ticket usually progresses through:

1. **Spec** — explore and formalize what needs to be done
2. **Plan** — design how to do it
3. **Execute** — implement the plan
4. _(optional)_ **AAD** — address follow-up fixes or small adjustments
5. **Description** — summarize the implemented work
