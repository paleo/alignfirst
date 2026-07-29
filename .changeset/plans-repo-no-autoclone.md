---
"@paleo/plans-repo": minor
---

`plans-repo setup` no longer clones the plans repository: point it at an existing clone (clone it yourself, with your own SSH configuration). The `--repo` option is removed — update the `plans:setup` npm script to `plans-repo setup --folder <name>` and document the repository URL in the instruction file.
