# @paleo/plans-repo

## 0.2.0

### Minor Changes

- 6d62bcf: `plans-repo setup` no longer clones the plans repository: point it at an existing clone (clone it yourself, with your own SSH configuration). The `--repo` option is removed — update the `plans:setup` npm script to `plans-repo setup --folder <name>` and document the repository URL in the instruction file.

## 0.1.0

### Minor Changes

- 60afd89: New `plans-repo` CLI: share the `.plans` directory through a dedicated team plans repository. `plans-repo setup <dir> --repo <url> --folder <name>` clones (or reuses) the plans repository and links `.plans` to the project's folder inside it, migrating any existing content. `plans-repo sync` pulls, commits, and pushes the plans repository.
