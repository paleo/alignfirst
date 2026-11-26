---
name: alcatchup
description: "Catch up with the current AlignFirst task: load its history, then continue with the user's instructions or summarize it."
disable-model-invocation: true
license: CC0 1.0
compatibility: Requires Node.js or Bun.
metadata:
  author: Paleo
  version: "4.0.2"
  repository: https://github.com/paleo/alignfirst
---

Run `npx -y alignfirst ticket <ticket-id> --catchup` to load the ticket history. If the ticket ID is unknown, run `npx -y alignfirst ticket --catchup` instead; the CLI deduces it from the branch. When it cannot, ask the user.

Then follow the user's instructions. Without instructions, return a short synthesis: what was requested, decided, done, and left open.

With Bun instead of Node.js, replace `npx -y` with `bunx --bun`.
