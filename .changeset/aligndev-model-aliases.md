---
"aligndev": minor
"alignfirst": patch
---

Added the `{latest}` placeholder, which selects the newest version of a model in the agent's catalog, the Pi profile key `modelFamilies`, and the Antigravity aliases `carbon`, `neon`, `hydrogen` and `flash`. Breaking: a Pi profile without declared models rejects `--model` and `defaultModel`. Convert the settings before or with the upgrade: see "Declare AlignDev Pi Models" in `alignfirst setup guide upgrade`. A host that runs `npx -y aligndev` without a version pin gets this release at once. The playbook now uses the user's word for side tickets.
