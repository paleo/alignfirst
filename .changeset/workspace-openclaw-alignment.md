---
"@paleo/workspace": minor
---

`workspace setup` adopts the OpenClaw-integration contract shared with `@paleo/alcoach`. Non-OpenClaw callers now **block by default** until finalize reaches READY/FAILED (replacing the removed `--wait` opt-in); when a callback URL is configured (`WORKSPACE_CALLBACK_URL` or `--callback-url`, plus `--session-key`) the command returns immediately and the detached finalize fires a completion callback (`POST { sessionKey, message, idempotencyKey }`, Bearer `WORKSPACE_CALLBACK_TOKEN`) so OpenClaw is woken reliably. A configured callback URL without `--session-key` exits non-zero.
