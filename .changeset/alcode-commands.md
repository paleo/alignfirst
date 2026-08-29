---
"@paleo/alcode": minor
---

The CLI is now command-based: `alcode new`, `alcode resume <sessionId>`, `alcode status <session-file>`, and `alcode usage`. `status` reconciles stale runs before reporting them. `new --protocol` requires `--ticket <id>` or `--no-ticket`, which reserves a `side-N` ticket; `alcode reserve-side-ticket` reserves one and prints its id. Added the `-m` alias for `--message`. Required messages reject blank values.
