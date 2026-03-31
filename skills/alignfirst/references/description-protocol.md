# How to Write a Description for Implemented Work

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the next CYCLE_LETTER - deduce it yourself - start with a new cycle (bump the CYCLE_LETTER, reset the FILE_NUMBER to 1)

Identify and state these values before starting the protocol.

## Steps

1. Find the current ticket plan directory.
2. If a `*description.md` file already exists in the TASK_DIR, find the latest one. Only read `*spec.md` and `*summary.md` files that come *after* it — earlier work is already covered.
   Otherwise, read all `*spec.md` and `*summary.md` files.
3. Write a new file `{CYCLE_LETTER}1-description.md` with the next cycle letter, containing a commit message and a description.

## Output Format

```md
# Description - [very short title]

**Suggested commit message:** `<commit message>`

[description body]
```

Start with a suggested commit message (follow the convention you are aware of, or default to `<type>: [<ticket_id>] very short description`). Refine it from the suggested commit messages found in the specs and summaries you read. Keep it brief—usually 3-5 words for the description part. Shorter is better when it's clear.

## Guidelines for the Description Body

- Write in markdown:
  - If there is one subject, write a single paragraph.
  - Otherwise, write a bulleted list with one subject per item.
- **Describe only WHAT was done, never WHY.** Never include explanations, justifications, or reasoning for the changes. Only state what was implemented or modified.
- **Keep it minimal and functional.** Mention each subject very concisely—just the essentials. Most subjects can be summarized in one sentence of about 5 to 15 words.
- **Always prefer functional/business descriptions.** Avoid technical implementation details unless absolutely necessary.
- **CRITICAL: Merge related subjects whenever possible.** Look for opportunities to combine similar changes into a single, cohesive subject. This keeps the description focused and readable.
- Include technical details only for major structural changes (e.g., renaming a database table, significant linter config changes, major codebase refactors).
- Do not mention specs that were not implemented. If in doubt, explore the codebase to confirm what was actually done.
- **Absorb fix-only summaries**: If a summary is about fixing issues introduced by previous summaries in the same ticket (e.g., bug fixes, corrections, adjustments to earlier work), do not mention it as a separate subject. An external reader only cares about the end state.

---

_Ignore lint errors (formatting issues) in the description file._

At the end, give the path of the description file to the user.
