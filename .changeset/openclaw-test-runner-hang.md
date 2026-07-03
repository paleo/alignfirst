---
"@paleo/openclaw-test": patch
---

Fix the intermittent post-verdict runner hang. The QA-bus long-poll now runs under a client-side `AbortController` (server hold + 2s) so a wedged bus or half-open connection surfaces as an empty poll and the caller's deadline loop keeps ticking instead of hanging forever. On shutdown the mock CLI server force-closes lingering keep-alive sockets (`closeAllConnections`) so `close()` resolves at once rather than waiting on an idle-open connection.
