---
"aligndev": minor
---

Added model aliases that follow the newest version: the `{latest}` placeholder in a model selector, the Pi profile key `modelFamilies`, the Antigravity aliases `carbon`, `neon`, `hydrogen` and `flash`, and `aligndev code models [--refresh]`. AlignDev remembers the model list of each profile in `~/.alignfirst/aligndev.store.sqlite`, refreshed daily and after a native CLI upgrade. Breaking: `aligndev` requires Node.js 22.13; a Pi profile accepts only the models it declares; an Antigravity profile accepts only its built-in aliases and declared names. Convert the settings before or with the upgrade: see "Declare AlignDev Pi Models" and "Declare AlignDev Antigravity Models" in `alignfirst setup guide upgrade`. A host that runs `npx -y aligndev` without a version pin gets this release at once. The playbook says _side issue_ where the tracker says _issue_.
