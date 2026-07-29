# How to Write a Code Review Report

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the CYCLE_LETTER and FILE_NUMBER — start a new cycle (bump CYCLE_LETTER, FILE_NUMBER = 1)
- the **base branch** to compare against - use the branch provided by the user, or fall back to the default branch.

Identify and state these values before starting the protocol.

## Overview

We need a code review for this branch, compared to the base branch.

Review with fresh eyes: derive intent from the code and the diff. Do not read specs, plans, summaries or any file content in TASK_DIR.

We need:

- The intent
- A short description of how it is done
- Is it the optimal way to implement this intent?
- If you see portions of code that could use a rewrite, the source file + start line (or range) with explanations

Be very concise.

Before reviewing, create your report as a new file `{CYCLE_LETTER}1-review.md` in the TASK_DIR, containing just the header — this reserves the filename, so a concurrent protocol session takes the next one. Write the report into it at the end.

## Output Format

```md
# Code Review - [very short title]

**Base branch:** `<base_branch>`

## Intent

[One or two sentences describing what this branch is trying to accomplish.]

## How It's Done

[Short description of the approach taken to implement the intent.]

## Assessment

[Is this the optimal way to implement this intent? Be direct. If yes, say so briefly. If not, explain what a better approach would be.]

## Suggested Rewrites

- `[file1.ts#10](/path/to/file1.ts#L10)`: [concise reason]
- `[file2.ts#20](/path/to/file2.ts#L20-L25)`: [concise reason]
```

Note:

- Link URLs must start with `/` (absolute from workspace root, e.g. `/src/file.ts#L10`). Never include a range in the link label.

---

_Ignore lint errors (formatting issues) in the review file._

At the end, give the path of the review file to the user.
