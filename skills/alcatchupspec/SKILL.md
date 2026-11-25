---
name: alcatchupspec
description: "Load the current AlignFirst task history, then execute the specification protocol."
disable-model-invocation: true
license: CC0 1.0
compatibility: Requires Node.js.
metadata:
  author: Paleo
  version: "4.0.1"
  repository: https://github.com/paleo/alignfirst
---

Run `npx -y alignfirst ticket <ticket-id> --catchup` to load the ticket history. If the ticket ID is unknown, run `npx -y alignfirst ticket --catchup` instead; the CLI deduces it from the branch. When it cannot, ask the user.

Then follow the `spec` protocol guide if it is already in context. Otherwise, run `npx -y alignfirst guide spec` and follow it; the output includes the ticket directory and work file rules. Do not use your own plan mode.
