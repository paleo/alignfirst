# Ticket Directory and Work Files

## Ticket Directory

TICKET_DIR holds a ticket's work files and includes a trailing slash. TICKET_ID is the external ticket ID, or `side-N` for a side ticket: work without a ticket.

{{TICKET_DETECTION}}

`{{TICKET_CMD}}` prints TICKET_DIR and its entries, creates a missing directory, and restores an archived one. Run it once to load the ticket directory context, unless `{{CMD}} ticket --catchup` already did.

{{PLANS_STATE}}

When the user says there is no ticket or asks for a side ticket, run `{{CMD}} ticket --side` and use the returned TICKET_ID in subsequent ticket commands. Reuse an existing `side-N` directory when the user refers to earlier work. Omit the ticket ID from commit messages.

## Work Files

Files use `{CYCLE_LETTER}{FILE_NUMBER}-{FILE_TYPE}.md`. FILE_PREFIX combines the cycle letter and the file number within that cycle. FILE_NAME includes the prefix and extension.

Immediately before creating each file, run `{{TICKET_CMD}} --next <filename>` with the extension included. It returns TICKET_DIR, CYCLE_LETTER, FILE_NUMBER, and FILE_NAME. Append FILE_NAME to TICKET_DIR exactly as printed to get the file path.

With no filename, `{{TICKET_CMD}} --next` returns FILE_PREFIX instead of FILE_NAME. To name several files at once, repeat `--next <filename>` once per file: the command returns FILE_NAMES, numbered in that order. Add `--new-cycle` to any form when the protocol or user calls for a new cycle.

No form reserves a number. Write the named file or files before requesting another filename. With `--json`, the same information uses the same field names.

Common file types are `spec`, `plan`, `AAD.summary`, `description`, `review`, and `merge.summary`. Use another type when needed.

Cycle letters and file numbers are internal. Never discuss them with the user.
