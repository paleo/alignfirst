# Specification Protocol

## Prerequisites

Run `{{TICKET_CMD}}` once to identify TICKET_DIR and load the ticket directory context (`{{CMD}} ticket --side` for a side ticket, when there is no ticket).

## Phases

A specification is produced in three phases, in this order:

1. **Investigation**: understand the current implementation and the problem.
2. **Discussion**: align with the user on the problem and the solution.
3. **Specification**: write the spec file, once the user has approved.

The usual failure is to write the spec right after investigating. The discussion comes first, every time.

## Phase 1. Investigation

Your context lists the available **documentation** and **skills**. Read every document and skill that applies to any aspect of the task, and the relevant references of each skill. A familiar-looking task tempts you to skip this reading; the project conventions live in these files.

Find the relevant source code. Take the time to understand how it works today and what has to change. Documentation lookup tools are welcome in this phase.

Seek a clean break solution by default. Consider backward compatibility only when the user asks for it.

## Phase 2. Discussion

Nothing is written in TICKET_DIR before the user agrees.

The user is a developer who carries the global vision of the project and decides the choices that matter. You carry the details of the code you just read. The discussion keeps the user aware of what you found and hands them every decision worth taking.

Manage the reader's attention. Open with the task as you understand it and the approach you propose, in two or three sentences. Then write one block per independent decision that needs the user. Write for a reader who has not opened the code today: a function, module or mechanism gets a few words of definition the first time you name it.

A block is a question and a recommendation:

```
❓ **Q1 - <title>**: <the problem in plain words, what the code does today in the words needed to decide, the options with their consequence>

➡️ <your recommendation>
```

Look for edge cases and impacts on the rest of the system; each one that needs a decision gets its block.

Every decision for the user is a numbered question, a yes/no one included; the simpler it is, the shorter its block. Numbering continues across rounds.

Settle on your own what the code can answer; routine choices belong in the opening approach. Ask the user what needs their judgement: product behavior, scope, priorities, constraints the code does not show. Leave out the investigation narrative and the list of files you read.

Ask in rounds: a question whose answer depends on another question still open waits for the next round. A question the reply skips stays open.

When several approaches are viable, present them with their trade-offs. Check that every sub-subject of the task has its block; a sub-subject skipped here is missing from the spec.

Do not use your question tool. Ask in plain text: your questions open a real discussion, a multiple-choice widget closes it.

## Phase 3. Specification

After the user approves your proposal, run `{{TICKET_CMD}} --next spec.md --new-cycle` to start a new cycle. Append FILE_NAME to TICKET_DIR, then immediately write the specification at that path. Do not overwrite an existing file.

Start with the title, a suggested commit message {{COMMIT_RULE}}, then the required documentation and skills. The shorter the commit message, the better. List each doc file individually, never a folder. Exclude `alignfirst` from the skills. Omit a field with nothing to list.

```text
# [{TICKET_ID}] Short Title

Suggested commit message: `<commit message>`

Required Documentation:

- `docs/topic-a/doc-1.md`
- `docs/topic-b/doc-2.md`

Required skills: `skill-1`, `skill-2`
```

Content rules:

- The spec covers the full scope of the task. Dropping a part to shrink the spec is a frequent failure; splitting the work is the job of the *plan* protocol. Flag inline a section that should land in its own plan ("candidate for a specialized plan").
- Spell out every change to a code contract: database schema and migrations, API shapes, critical type definitions. Leave out other code; refer to source files by path or function name.
- The code may change before the spec is executed. Name functions, never line numbers.
- Specify a clean break. Unused code is removed. Backward compatibility appears only when the user asked for it.
- Leave out sections that add no information: "Benefits", "Code Style Compliance", and the like. Problem and solution only.

Ignore Markdown lint errors in the spec file. Fixing them wastes the session.

At the end, give the path of the spec file to the user.
