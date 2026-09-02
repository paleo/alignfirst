---
"@paleo/plans-share": minor
---

Added `archive <ticket-id | path>` and `auto-archive`, which move ticket directories to `.plans/_archives/`, and the `sync --auto-archive` option. Auto-archiving moves the ticket directories and no-ticket alcode session files untouched for `PLANS_SHARE_ARCHIVE_DAYS` days (default 7).
