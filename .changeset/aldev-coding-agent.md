---
"aldev": minor
---

Added the `codingAgent` platform: a Claude Code or Codex session acts as the assistant on one project, started by the new `aldev` skill. `aldev` now runs through `npx`, and then prints and runs `npx -y aldev` and `npx -y alignfirst`. The config now requires `platform` and `code`.
