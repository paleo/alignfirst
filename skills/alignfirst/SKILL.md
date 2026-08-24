---
name: alignfirst
description: "Collaborative problem-solving protocols. Read only when the user explicitly names AlignFirst or a protocol alias: spec, alspec, plan, alplan, AAD, al, merge, almerge, alreview, or aldescription."
license: CC0 1.0
metadata:
  author: Paleo
  version: "3.10.0"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Guide

If you don't already know which protocol to use, read [overview.md](references/overview.md) first.

## Protocols

- **Technical Specification** (_spec_, or _alspec_): [spec-protocol.md](references/spec-protocol.md)
- **Implementation Plans** (_plan_, or _alplan_): [plan-protocol.md](references/plan-protocol.md)
- **Align-and-Do Protocol** (_AAD_): [aad-protocol.md](references/aad-protocol.md)
- **Merge** (_merge_, or _almerge_): [merge-protocol.md](references/merge-protocol.md)
- **Code Review** (_alreview_): [review-protocol.md](references/review-protocol.md)
- **Description** (_aldescription_): [description-protocol.md](references/description-protocol.md)

## TASK_DIR Location

**TASK_DIR** is the directory where work files related to a task are stored. Usually, we use **TASK_DIR** = `.plans/{TICKET_ID}/` (a sub-directory of the `.plans` folder). If no ticket ID is known, ask the user for it.

- Create TASK_DIR if it doesn't exist
- Or, list all existing files (do not truncate)

**Work without a ticket:** when the user says there is no ticket, use `nt-{N}` as the TICKET_ID: find the highest `nt-{N}` directory in `.plans/` and take N + 1 (`nt-1` if there is none). Reuse an existing `nt-{N}` directory when the user refers to that earlier work. Omit the ticket ID from commit messages.

## File Naming Convention

Format: `{CYCLE_LETTER}{FILE_NUMBER}-{FILE_TYPE}.md`

**Common file types:**

- `spec` - technical specification
- `plan` - implementation plan
- `AAD.summary` - AAD summary document
- `description` - PR/MR description
- `review` - code review report
- `merge.summary` - merge conflicts resolution summary

**Example structure:**

```text
.plans/
├── 123/
│   ├── A1-spec.md
│   ├── A2-plan.md
│   └── A3-AAD.summary.md
│   └── B1-spec.md
```

## Notes

- **TICKET_ID** is a unique identifier for the task, often an issue or ticket number.
- Cycles are identified by a **CYCLE_LETTER** (A, B, C...).
- The protocol or the user decides whether the next file continues the current cycle or starts a new one.
- To determine the next filename in the current cycle: find the highest CYCLE_LETTER, then the highest FILE_NUMBER within it. Bump the number.
- For a new cycle: bump CYCLE_LETTER and reset FILE_NUMBER to 1.
- Do not bother the user with CYCLE_LETTER or FILE_NUMBER. They are for internal organization. Start CYCLE_LETTER with `A` if there is no existing cycle. So you just need to ask for a **ticket ID** if you don't have one.
- There is no strict sequence of file types in the workflow. Available file types are also flexible; if you need a new one, just create it.
