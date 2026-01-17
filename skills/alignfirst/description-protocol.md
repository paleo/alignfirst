# How to Write a Description for Implemented Work

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the next CYCLE_LETTER - deduce it yourself - start with a new cycle (bump the CYCLE_LETTER, reset the FILE_NUMBER to 1)

Identify and state these values before starting the protocol.

## Steps

1. Find the current ticket plan directory.
2. Read every `*spec.md` and `*summary.md` file in the ticket plan directory.
3. Write a description and a commit message in a new file `{CYCLE_LETTER}1-description.md` with the next cycle letter.

## Guidelines for the Description

- Write in markdown:
  - If there is one subject, write a single paragraph.
  - Otherwise, write a bulleted list with one subject per item.
- **Describe only WHAT was done, never WHY.** Never include explanations, justifications, or reasoning for the changes. Only state what was implemented or modified.
- **Keep it minimal and functional.** Mention each subject very concisely—just the essentials. Most subjects can be summarized in one sentence of about 5 to 15 words.
- **Always prefer functional/business descriptions.** Avoid technical implementation details unless absolutely necessary.
- **CRITICAL: Merge related subjects whenever possible.** Look for opportunities to combine similar changes into a single, cohesive subject. This keeps the description focused and readable.
- Include technical details only for major structural changes (e.g., renaming a database table, significant linter config changes, major codebase refactors).
- Do not mention specs that were not implemented. If in doubt, explore the codebase to confirm what was actually done.

## Commit message

At the end of the file, add a commit message in _Conventional Commits_ format:

```md
**Commit message:** <type>: [<ticket_id>] very short description
```

Where `<type>` is one of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`.

Keep the description brief—usually 3-5 words is sufficient. Occasionally more words are needed, but avoid being verbose. Shorter is better when it's clear.

---

_Important Note: There can be lint errors in the markdown file you write. Ignore them. NEVER FIX LINT ERRORS (FORMATTING ISSUES) IN THE DESCRIPTION._
