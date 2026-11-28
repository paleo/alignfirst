---
"aligndev": minor
"alignfirst": patch
---

Added the `{latest}` placeholder, the Pi profile key `modelFamilies`, the Antigravity aliases `carbon`, `neon`, `hydrogen` and `flash`, and `aligndev code models [--refresh]`. A `{latest}` pattern selects the newest version in the model list that AlignDev remembers in `~/.alignfirst/aligndev.store.sqlite`, refreshed daily and after a native CLI upgrade. Breaking: `aligndev` requires Node.js 22.13; an Antigravity profile accepts only its declared names, like the others; a Pi profile without declared models rejects `--model` and `defaultModel`. Convert the settings before or with the upgrade: see "Declare AlignDev Pi Models" and "Declare AlignDev Antigravity Models" in `alignfirst setup guide upgrade`. A host that runs `npx -y aligndev` without a version pin gets this release at once. The playbook now uses the user's word for side tickets.
