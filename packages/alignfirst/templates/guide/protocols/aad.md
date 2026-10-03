# Align-and-Do Protocol (AAD)

## Prerequisites

Run `{{TICKET_CMD}}` once to identify TICKET_DIR and load the ticket directory context (`{{CMD}} ticket --side` for a side ticket, when there is no ticket).

---

This is a 4-step protocol. Follow each step in order.

## 1. Investigate

Your context lists the available **documentation** and **skills**. Read every document and skill that applies to any aspect of the task, and the relevant references of each skill. A familiar-looking task tempts you to skip this reading; the project conventions live in these files.

Explore the codebase. Take the time to understand how it works today and what needs to change.

Seek a clean break solution by default. Consider backward compatibility only when the user asks for it.

## 2. Discuss

Nothing is implemented, and nothing is written in TICKET_DIR, before the user agrees. This step is where a small task reveals itself as a large one. It is never skipped.

The user is a developer who carries the global vision of the project and decides the choices that matter. You carry the details of the code you just read. The discussion keeps the user aware of what you found and hands them every decision worth taking.

Manage the reader's attention. Open with the task as you understand it and the approach you propose, in two or three sentences. Then write one block per point that deserves a decision. Write for a reader who has not opened the code today: a function, module or mechanism gets a few words of definition the first time you name it.

A block is a question and a recommendation:

```
❓ **Q1 - <title>**: <the problem in plain words, what the code does today in the words needed to decide, the options with their consequence>

➡️ <your recommendation>
```

Look for edge cases and impacts on the rest of the system; each one that needs a decision gets its block.

A ❓ is open: the user's answer shapes what you build. When the only answers are go or veto, the block shrinks to a single ➡️ line stating your choice. The more obvious the choice, the shorter the line. Leave out the investigation narrative and the list of files you read.

Settle on your own what the code can answer. Ask the user what needs their judgement: product behavior, scope, priorities, constraints the code does not show. Every ❓ carries a ➡️, so that "fine with all recommendations" is a valid answer. Ask in rounds: a question whose answer depends on another question still open waits for the next round.

When there is nothing to decide, say so in a few lines and ask for an explicit go.

Do not use your question tool. Ask in plain text: your questions open a real discussion, a multiple-choice widget closes it.

## 3. Act

When you and the user agree, run `{{TICKET_CMD}} --next AAD.summary.md` to continue the current cycle. Append FILE_NAME to TICKET_DIR, then immediately create the summary file at that path. Do not overwrite an existing file. Start implementing after creating it.

Maintain the file as a **live report** while you work.

Use subagents (your subagent tool) for distinct, isolated units of work when beneficial.

## 4. Summarize

Finalize the summary file: replace the working notes with the final content described below.

Start the summary with a header, then a suggested commit message {{COMMIT_RULE}}. The shorter the better. Omit any field with nothing to list. Exclude `alignfirst` from the skills.

Example:

```markdown
# AAD Summary - [very short title]

Suggested commit message: `<commit message>`

Used documentation:

- `docs/topic-a/doc-1.md`
- `docs/topic-b/doc-2.md`

Used skills: `skill-a`, `skill-b`
```

The finalized summary is a **very concise handover document**. It captures:

- What was the topic or problem
- What was decided or discovered
- What action was taken, if any
- Key outcomes or next steps

The shorter the better.

Ignore Markdown lint errors in the summary file.

At the end, give the path of the summary file to the user.
