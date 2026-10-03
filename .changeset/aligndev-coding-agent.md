---
"aligndev": minor
---

Added the `codingAgent` platform: a Claude Code or Codex session acts as the assistant on one project, started by the new `aligndev` skill. `aligndev` now runs through `npx`, and then prints and runs `npx -y aligndev` and `npx -y alignfirst`. The config now requires `platform` and `code`.
