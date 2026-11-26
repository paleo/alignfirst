---
name: aligndev
description: "Act as the AlignFirst assistant: delegate the work on this project to agent sessions through aligndev."
disable-model-invocation: true
license: CC0 1.0
compatibility: Requires Node.js or Bun, and Git.
metadata:
  author: Paleo
  version: "1.0.3"
  repository: https://github.com/paleo/alignfirst
---

Follow the `aligndev` playbook if it is already in context. Otherwise, run `npx -y aligndev guide` and follow it.

If your sandbox blocks `npx -y aligndev guide`, rerun it outside the sandbox.

With Bun instead of Node.js, replace `npx -y` with `bunx --bun`.
