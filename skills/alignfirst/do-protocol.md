# Align-and-Do Protocol (AAD)

## Pre-requisites

You need:

- the TASK_DIR - if you don't have it, use your instructions for finding the **ticket ID**, or ask the user
- the current CYCLE_LETTER and the bumped FILE_NUMBER - deduce them yourself

Identify and state these values before starting the protocol.

---

## 1. Investigate

List all available **skills** and read each one whose description applies to any aspect of the task. In each skill, take the time to **read the relevant references**.

Explore the codebase. Take the time to understand how it currently works and what needs to change.

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

Start the summary with:

```markdown
# AAD Summary - [very short title in a few words]

Used Skills: [list, excluding alignfirst]
```

The finalized summary is a **very concise handover document** that should capture:

- What was the topic or problem
- What was decided or discovered
- What action was taken (if any)
- Key outcomes or next steps

The shorter the better.

_Ignore markdown lint errors in the summary file._
