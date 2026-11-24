# Review Protocol

## Prerequisites

You need:

- the TICKET_DIR and ticket directory context — run `{{TICKET_CMD}}` once (`{{CMD}} ticket --side` for a side ticket, when there is no ticket)
- {{BASE_BRANCH_RULE}}

Identify TICKET_DIR and the base branch before starting the protocol.

The caller may also give:

- a **starting commit** — the review then covers the commits added after it, usually since an earlier review. Without one, it covers the whole branch.
- a **form** — light or regular. Without one, you choose it in Phase 1.

## Overview

We need a code review for a change: this branch compared to the base branch, or the commits added after the starting commit. A code review, above all, guarantees that the codebase stays healthy.

You are the orchestrator: you scope the work, have the change reviewed, then write a single report. A regular review runs one reviewer subagent per perspective and merges their findings. A light review is one pass you make yourself. Reviewers work with fresh eyes — they derive intent from the code and the diff. Neither you nor the reviewers read specs, plans, summaries, earlier reviews, or any file content in TICKET_DIR. A review is read-only: it fixes nothing.

Before starting, run `{{TICKET_CMD}} --next review.md --new-cycle` to start a new cycle. Append FILE_NAME to TICKET_DIR, then immediately create the report at that path with just the header. Creating the file reserves the filename. Write the report into it at the end.

## Phase 1. Scoping

1. Find the **comparison point**, the commit or tree that the review compares HEAD with. The review target is HEAD as committed; note its SHA with `git rev-parse HEAD`.
   - **Whole branch** — the merge-base: `git merge-base <base_branch> HEAD`.
   - **Starting commit** — the starting commit itself, with two exceptions:
     - `git merge-base --is-ancestor <starting_commit> HEAD` fails. The history was rewritten: review the whole branch.
     - `git merge-base <base_branch> <starting_commit>` differs from the merge-base. The base branch was merged in after the starting commit, and its commits are outside the change. Run `git merge-tree --write-tree <starting_commit> <merge_base>`: the tree it prints holds the starting commit merged with the base, and is the comparison point. When the command reports a conflict, review the whole branch.

   Then get the change overview: `git diff --stat <comparison_point> HEAD`.

2. Choose the **form**. The caller's choice wins. Otherwise, take the light review when the change is minor: a small diff, roughly under 100 changed lines outside generated files and lockfiles, where a mistake would be cheap to notice and to undo. Size is a first indication; what the change does decides. Widening a column is minor. Ten lines in an authorization check are not. When in doubt, run the regular review.
3. For a regular review, select the **ecosystem modules** from the changed files and the repo configuration:

   | Changed files | Condition | `--module` value |
   | --- | --- | --- |
   | TypeScript | `strict` enabled in the applicable tsconfig | `typescript-strict` |
   | TypeScript | `strict` disabled | `javascript` |
   | JavaScript | — | `javascript` |
   | Python | — | `python` |
   | Other stacks | — | no module; the perspectives cover them |

   A diff spanning several ecosystems gets all the applicable modules.

4. Note the **active tooling**: type-checker and its strictness, linter, formatter. A review skips what the tooling already catches.
5. Note the **repo coding conventions**: instruction files (CLAUDE.md, AGENTS.md) and coding-style skills that apply to the changed files. Collect paths, not content.

## Phase 2. Review

### Light review

Run `{{CMD}} guide review --reviewer light` from the project root and follow its output yourself, without subagents. It replaces the perspectives and the ecosystem modules.

### Regular review

Launch four reviewer subagents in parallel:

| Reviewer | `--reviewer` value | `--module` values from Phase 1 |
| --- | --- | --- |
| Intent | `intent` | none |
| Correctness | `correctness` | from Phase 1 |
| Change Safety | `safety` | from Phase 1 |
| Code Quality | `quality` | from Phase 1 |

Each subagent prompt must contain:

- the command `{{CMD}} guide review --reviewer <perspective> --module <module>...` to run from the project root, with the modules selected in Phase 1, and the instruction to read its output before anything else
- the base branch and the comparison point
- the tooling notes from Phase 1
- for the intent and quality reviewers: the convention paths from Phase 1
- the instruction that its final message is its report, in the format the reviewer rules define

_If your environment has no subagent tool, or a subagent cannot run commands, execute the four perspectives yourself, sequentially — intent, correctness, change safety, code quality — each from the output of its command._

## Phase 3. Merge and Verify

A light review has one reviewer: it skips step 1.

1. **Dedupe**: same location and same defect reported by several reviewers → keep one, at the highest severity.
2. **Verify**: for each 🔴 and 🟣 finding, read the cited lines yourself. Drop or downgrade a finding whose evidence does not hold.
3. **Cap the noise**: keep the most valuable 🟡 findings, in proportion to the diff — about five for a typical diff, fewer for a small one, up to ten for a very large one — and state the number left out. A review with zero findings is a valid outcome; open the assessment with "no blocking issues" when there is no 🔴.
4. **Rewrite for the reader**: a finding states its defect first; evidence and remedy follow. Rewrite any merged finding that buries the defect or narrates commit history.
5. **Reconcile the verdict**: adjust the assessment and verdict (the intent reviewer's, or your own in a light review) to reflect the merged, verified findings. A surviving 🔴 forbids "mergeable as is".

## Phase 4. Output Format

```md
# Code Review - [very short title]

- **Base branch:** `<base_branch>`
- **Reviewed commit:** `<full SHA of HEAD>`
- **Starting commit:** `<full SHA>`
- **Form:** light | regular

## Intent

[One or two sentences describing what this change is trying to accomplish.]

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

- A later review starts from the `Reviewed commit` line.
- Write the `Starting commit` line only when the review started from one. When a starting commit was given and you reviewed the whole branch, omit the line and open the assessment with the reason.
- The Intent, How It's Done, and Assessment sections describe the reviewed change. In a regular review they come from the intent reviewer, whose rewrite suggestions become findings.
- Omit a severity section when it is empty. When there is no finding at all, replace the Findings section with a single line stating it.
- Link URLs must start with `/` (absolute from workspace root, e.g. `/src/file.ts#L10`). Never include a range in the link label.

---

_Ignore lint errors (formatting issues) in the review file._

At the end, give the path of the review file to the user.
