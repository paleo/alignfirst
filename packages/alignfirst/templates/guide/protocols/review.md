# How to Write a Code Review Report

## Pre-requisites

You need:

- the TASK_DIR — run `{{TICKET_CMD}}` (`{{CMD}} ticket --side` when there is no ticket)
- the CYCLE_LETTER and FILE_NUMBER — start a new cycle: `{{TICKET_CMD}} --next review.md --new-cycle` prints the file to create
- {{BASE_BRANCH_RULE}}

Identify and state these values before starting the protocol.

## Overview

We need a code review for this branch, compared to the base branch. A code review, above all, guarantees that the codebase stays healthy.

You are the orchestrator: you scope the work, run one reviewer subagent per perspective, then merge their findings into a single report. Reviewers work with fresh eyes — they derive intent from the code and the diff. Neither you nor the reviewers read specs, plans, summaries, or any file content in TASK_DIR.

Before starting, create your report as a new file `{CYCLE_LETTER}1-review.md` in the TASK_DIR, containing just the header — this reserves the filename. Write the report into it at the end.

## Phase 1. Scoping

1. Find the merge-base: `git merge-base <base_branch> HEAD`, then get the change overview: `git diff --stat <merge_base> HEAD`. The review target is the branch as committed.
2. Select the **ecosystem modules** from the changed files and the repo configuration:

   | Changed files | Condition | `--module` value |
   | --- | --- | --- |
   | TypeScript | `strict` enabled in the applicable tsconfig | `typescript-strict` |
   | TypeScript | `strict` disabled | `javascript` |
   | JavaScript | — | `javascript` |
   | Python | — | `python` |
   | Other stacks | — | no module; the perspectives cover them |

   A diff spanning several ecosystems gets all the applicable modules.

3. Note the **active tooling**: type-checker and its strictness, linter, formatter. Reviewers use this to skip what the tooling already catches.
4. Note the **repo coding conventions**: instruction files (CLAUDE.md, AGENTS.md) and coding-style skills that apply to the changed files. Collect paths, not content.

## Phase 2. Perspective Reviews

**Small diff** (roughly under 100 changed lines, outside generated files and lockfiles): skip the subagents. Execute the perspectives yourself, sequentially — intent, correctness, safety, quality — reading the same files. The rest of the protocol is unchanged.

Otherwise, launch four reviewer subagents in parallel:

| Reviewer | `--reviewer` value | `--module` values from Phase 1 |
| --- | --- | --- |
| Intent | `intent` | none |
| Correctness | `correctness` | from Phase 1 |
| Change safety | `safety` | from Phase 1 |
| Quality | `quality` | from Phase 1 |

Each subagent prompt must contain:

- the command `{{CMD}} guide review --reviewer <perspective> --module <module>...` to run from the project root, with the modules selected in Phase 1, and the instruction to read its output before anything else
- the base branch and the merge-base
- the tooling notes from Phase 1
- for the intent and quality reviewers: the convention paths from Phase 1
- the instruction that its final message is its report, in the format the reviewer rules define

_If your environment has no subagent tool, or a subagent cannot run commands, follow the small-diff procedure regardless of the diff size._

## Phase 3. Merge and Verify

1. **Dedupe**: same location and same defect reported by several reviewers → keep one, at the highest severity.
2. **Verify**: for each 🔴 and 🟣 finding, read the cited lines yourself. Drop or downgrade a finding whose evidence does not hold.
3. **Cap the noise**: keep the most valuable 🟡 findings, in proportion to the diff — about five for a typical diff, fewer for a small one, up to ten for a very large one — and state the number left out. A review with zero findings is a valid outcome; open the assessment with "no blocking issues" when there is no 🔴.
4. **Rewrite for the reader**: a finding states its defect first; evidence and remedy follow. Rewrite any merged finding that buries the defect or narrates commit history.
5. **Reconcile the verdict**: adjust the intent reviewer's assessment and verdict to reflect the merged, verified findings. A surviving 🔴 forbids "mergeable as is".

## Phase 4. Output Format

```md
# Code Review - [very short title]

**Base branch:** `<base_branch>`

## Intent

[One or two sentences describing what this branch is trying to accomplish.]

## How It's Done

[Short description of the approach taken to implement the intent.]

## Assessment

[Is this the optimal way to implement this intent? Be direct. If yes, say so briefly. If not, explain what a better approach would be. End with the verdict: mergeable as is | mergeable after fixes | needs rework.]

## Findings

### 🔴 Important

- [`file1.ts#10`](/path/to/file1.ts#L10): [what is wrong, why it matters, and the scenario that triggers it]

### 🟡 Nits

- [`file2.ts#20`](/path/to/file2.ts#L20-L25): [concise reason]

### 🟣 Pre-existing

- [`file3.ts#30`](/path/to/file3.ts#L30): [concise reason]
```

Note:

- The Intent, How It's Done, and Assessment sections come from the intent reviewer; the intent reviewer's rewrite suggestions become findings.
- Omit a severity section when it is empty. When there is no finding at all, replace the Findings section with a single line stating it.
- Link URLs must start with `/` (absolute from workspace root, e.g. `/src/file.ts#L10`). Never include a range in the link label.

---

_Ignore lint errors (formatting issues) in the review file._

At the end, give the path of the review file to the user.
