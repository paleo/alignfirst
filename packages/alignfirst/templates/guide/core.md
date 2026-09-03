# AlignFirst Guide

An agent that does not know which protocol to use runs `{{CMD}} guide overview`.

## Protocols

- **Technical Specification** (_spec_, or _alspec_): `{{CMD}} guide spec --protocol-only`
- **Implementation Plans** (_plan_, or _alplan_): `{{CMD}} guide plan --protocol-only`
- **Align-and-Do Protocol** (_AAD_): `{{CMD}} guide aad --protocol-only`
- **Catch Up** (_catchup_, or _alcatchup_): `{{CMD}} guide catchup --protocol-only`
- **Merge** (_merge_, or _almerge_): `{{CMD}} guide merge --protocol-only`
- **Code Review** (_alreview_): `{{CMD}} guide review --protocol-only`
- **Description** (_aldescription_): `{{CMD}} guide description --protocol-only`

## TASK_DIR Location

**TASK_DIR** is `.plans/{TICKET_ID}/`. Run `{{CMD}} ticket <id>` and use the directory it prints. The command creates a missing directory, restores an archived one, and lists its entries.

{{TICKET_ID_RULE}}

**Work without a ticket:** when the user says there is no ticket, run `{{CMD}} ticket --side`. Reuse an existing `side-N` directory when the user refers to that earlier work. Omit the ticket ID from commit messages.

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
- `{{CMD}} ticket <id> --next <filename>` prints the next filename in the current cycle, the extension included (`--next spec.md` giving `.plans/123/A2-spec.md`).
- `--new-cycle` starts a new cycle.
- The protocol or the user decides whether to continue the current cycle or start a new one.
- Cycle letters and file numbers are internal. Never discuss them with the user.
- New file types are welcome.
