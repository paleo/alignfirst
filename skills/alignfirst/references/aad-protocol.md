# Align-and-Do Protocol (AAD)

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the CYCLE_LETTER and FILE_NUMBER — continue the current cycle (same CYCLE_LETTER, bump FILE_NUMBER)

Identify and state these values before starting the protocol.

---

This is a 4-step protocol. Follow each step in order.

## 1. Investigate

Check your context for available **documentation** and **skills**. Read every document and skill relevant to any aspect of the task — this is not optional. For each skill, also **read its relevant references**.

Explore the codebase. Take the time to understand how it currently works and what needs to change.

Always seek a clean break solution by default. Never consider backward compatibility unless explicitly requested.

## 2. Discuss

Present your findings and proposed approach. Ask clarifying questions. Explore trade-offs and edge cases.

**Remember**: This discussion happens BEFORE any implementation or formal specification writing.

Engage in a thorough collaborative discussion covering:

- **Problem/Goal exploration**: Present your understanding and ask clarifying questions
- **Current implementation analysis**: Share what you discovered and ask for confirmation or corrections
- **Approach evaluation**: Discuss potential solutions and their trade-offs
- **Edge cases and implications**: Explore potential issues and broader system impacts

**This phase is mandatory.** You're new to this project, the user can guide you.

## 3. Act

When you and the user agree, start implementing.

For **complex work** only (risk of context exhaustion):

- Create your summary file as you go, then update it as a working document.
- Use subagents (your subagent tool) for distinct, isolated units of work when beneficial.

## 4. Summarize

Write the summary file in TASK_DIR. Compose the filename using the current CYCLE_LETTER and the bumped FILE_NUMBER, then append `-AAD.summary.md`. For example, if the last file is `E5-plan-something.md`, create `E6-AAD.summary.md`. Do not overwrite an existing file.

Start the summary with a header, then a suggested commit message (follow the convention you are aware of, or default to `<type>: [<ticket_id>] very short description`). The shorter the better. Omit any field with nothing to list. Always exclude `alignfirst` from skills.

Example:

```markdown
# AAD Summary - [very short title]

Suggested commit message: `<commit message>`

Used documentation:

- `docs/topic-a/doc-1.md`
- `docs/topic-b/doc-2.md`

Used skills: `skill-a`, `skill-b`
```

The finalized summary is a **very concise handover document** that should capture:

- What was the topic or problem
- What was decided or discovered
- What action was taken (if any)
- Key outcomes or next steps

The shorter the better.

_Ignore markdown lint errors in the summary file._

At the end, give the path of the summary file to the user.
