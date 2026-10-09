# Description Protocol

## Prerequisites

Run `{{TICKET_CMD}}` once to identify TICKET_DIR and load the ticket directory context (`{{CMD}} ticket --side` for a side ticket, when there is no ticket).

## Steps

1. Run `{{TICKET_CMD}} --next description.md --new-cycle` to start a new cycle.
2. Append FILE_NAME to TICKET_DIR, then immediately create the description at that path with just the header. Creating the file reserves the filename.
3. If a previous `*description.md` file exists in the TICKET_DIR, find the latest one. Only read `*spec.md` and `*summary.md` files that come *after* it — earlier work is already covered.
   Otherwise, read all `*spec.md` and `*summary.md` files.
4. Write the commit message and description into your file.

## Output Format

```md
# Description - [very short title]

**Suggested commit message:** `<commit message>`

## PR/MR Description

[description body]
```

Start with a suggested commit message {{COMMIT_RULE}}. Refine it from the suggested commit messages found in the specs and summaries you read. Keep it brief, usually 3 to 5 words for the description part. Shorter is better when it stays clear.

## Guidelines for the Description Body

- Write in markdown:
  - If there is one subject, write a single paragraph.
  - Otherwise, write a bulleted list with one subject per item.
- **Describe what was done, never why.** Explanations, justifications and reasoning stay out; the reader gets the result.
- **Keep it minimal and functional.** Mention each subject very concisely, the essentials only. Most subjects fit in one sentence of about 5 to 15 words.
- **Prefer functional descriptions.** Technical implementation details appear only when the reader needs them.
- **Merge related subjects.** A long list of small items is the usual failure of a description; combine similar changes into one cohesive subject.
- Include technical details only for major structural changes (e.g., renaming a database table, significant linter config changes, major codebase refactors).
- Leave out specs that were not implemented. In doubt, explore the codebase to confirm what was done.
- **Absorb fix-only summaries.** A summary that fixes issues introduced by earlier work in the same ticket is not a subject of its own. An external reader only cares about the end state.

---

Ignore Markdown lint errors in the description file.

At the end, give the path of the description file to the user.
