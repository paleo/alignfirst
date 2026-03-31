---
name: alignfirst
description: "Collaborative problem-solving protocols. Write technical specifications (spec, or alspec), create implementation plans (plan, or alplan), or use Align-and-Do Protocol (AAD). Also generates PR/MR descriptions (aldescription) and code review reports (alreview)."
license: CC0 1.0
metadata:
  author: Paleo
  version: "3.3.1"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Guide

If you don't already know which protocol to use, read [overview.md](references/overview.md) first.

## Protocols

- **Technical Specification** (_spec_, or _alspec_): [spec-protocol.md](references/spec-protocol.md)
- **Implementation Plans** (_plan_, or _alplan_): [plan-protocol.md](references/plan-protocol.md)
- **Align-and-Do Protocol** (_AAD_): [aad-protocol.md](references/aad-protocol.md)
- **Description** (_aldescription_): [description-protocol.md](references/description-protocol.md)
- **Code Review** (_alreview_): [review-protocol.md](references/review-protocol.md)

## TASK_DIR Location

**TASK_DIR** is the directory where work files related to a task are stored. Usually, we use **TASK_DIR** = `.plans/{TICKET_ID}/` (a sub-directory of the `.plans` folder). If no ticket ID is known, ask the user for it.

- Create TASK_DIR if it doesn't exist
- Or, list existing files

## File Naming Convention

Format: `{CYCLE_LETTER}{FILE_NUMBER}-{FILE_TYPE}.md`

**Common file types:**

- `spec` - technical specification
- `plan` - implementation plan
- `AAD.summary` - AAD summary document
- `description` - PR/MR description
- `review` - code review report

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
- Cycles are identified by a **CYCLE_LETTER** (A, B, C...). The user decides when to start a new one.
- In a cycle, determine the next **FILE_NUMBER** from existing file names. Every new file must have a bumped file number.
- Do not bother the user with CYCLE_LETTER or FILE_NUMBER. They are for internal organization. It's up to you to list the files and determine the last CYCLE_LETTER and FILE_NUMBER. Start CYCLE_LETTER with `A` if there is no existing cycle, and FILE_NUMBER with `1`. So you just need to ask for a **ticket ID** if you don't have one.
- When the user requests a new cycle: bump CYCLE_LETTER and reset FILE_NUMBER.
- There is no strict sequence of file types in the workflow. Available file types are also flexible; if you need a new one, just create it.
