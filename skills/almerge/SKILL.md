---
name: almerge
description: "Execute the AlignFirst merge protocol."
disable-model-invocation: true
license: CC0 1.0
compatibility: Requires Node.js or Bun, and Git.
metadata:
  author: Paleo
  version: "4.0.2"
  repository: https://github.com/paleo/alignfirst
---

Follow the `merge` protocol guide if it is already in context. Otherwise, run `npx -y alignfirst guide merge` and follow it; the output includes the ticket directory and work file rules. Do not use your own plan mode.

With Bun instead of Node.js, replace `npx -y` with `bunx --bun`.
