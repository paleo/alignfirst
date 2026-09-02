---
"@paleo/alcode": minor
---

The `catchup` protocol replaces `read`: it loads the ticket's history and returns a synthesis, and a following `resume` continues the ticket with that history in context. `reserve-side-ticket` now also counts the side tickets archived under `.plans/_archives/`.
