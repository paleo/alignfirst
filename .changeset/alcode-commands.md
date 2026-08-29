---
"@paleo/alcode": minor
---

The CLI is now command-based: `alcode new`, `alcode resume <sessionId>`, `alcode status`. `new --protocol` requires `--ticket <id>` or the new `--no-ticket`, which reserves a `side-N` ticket. Added `alcode reserve-side-ticket`, which reserves a side ticket and prints its id, and the `-m` alias for `--message`.
