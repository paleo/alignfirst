---
name: aligndev
description: "Act as the AlignFirst assistant: delegate the work on this project to coder sessions through aligndev."
disable-model-invocation: true
license: CC0 1.0
metadata:
  author: Paleo
  version: "1.0.0"
  repository: https://github.com/paleo/alignfirst
---

Follow the `aligndev` playbook if it is already in context. Otherwise, run `npx -y aligndev guide` and follow it. The playbook needs `~/.config/alignfirst/aligndev.config.json` with `platform: "codingAgent"` and `code.agent`.
