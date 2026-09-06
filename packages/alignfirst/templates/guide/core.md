# Shared Conventions

## Task directory

TASK_DIR holds a ticket's work files. TICKET_ID identifies the task, usually by its issue or ticket number.

{{TICKET_CONTEXT}}

`{{TICKET_CMD}}` prints TASK_DIR and its entries, creates a missing directory, and restores an archived one. Adding `--next <filename>` also prints the next file path.

{{PLANS_STATE}}

When the user says there is no ticket, run `{{CMD}} ticket --side`. Reuse an existing `side-N` directory when the user refers to earlier work. Omit the ticket ID from commit messages.

## Work files

Files use `{CYCLE_LETTER}{FILE_NUMBER}-{FILE_TYPE}.md`, such as `A1-spec.md` or `A2-AAD.summary.md`.

Use `{{TICKET_CMD}} --next <filename>` to get the next path in the current cycle, including the extension. For example, `--next spec.md` may return a path ending in `A2-spec.md`. Add `--new-cycle` when the protocol or user calls for a new cycle.

Common file types are `spec`, `plan`, `AAD.summary`, `description`, `review`, and `merge.summary`. Use another type when needed.

Cycle letters and file numbers are internal. Never discuss them with the user.
