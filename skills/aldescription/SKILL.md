---
name: aldescription
description: "Execute the AlignFirst description protocol."
disable-model-invocation: true
license: CC0 1.0
compatibility: Requires Node.js or Bun.
metadata:
  author: Paleo
  version: "4.0.2"
  repository: https://github.com/paleo/alignfirst
---

Follow the `description` protocol guide if it is already in context. Otherwise, run `npx -y alignfirst guide description` and follow it; the output includes the ticket directory and work file rules. Do not use your own plan mode.

With Bun instead of Node.js, replace `npx -y` with `bunx --bun`.
