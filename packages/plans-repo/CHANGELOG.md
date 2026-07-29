# @paleo/plans-repo

## 0.1.0

### Minor Changes

- 60afd89: New `plans-repo` CLI: share the `.plans` directory through a dedicated team plans repository. `plans-repo setup <dir> --repo <url> --folder <name>` clones (or reuses) the plans repository and links `.plans` to the project's folder inside it, migrating any existing content. `plans-repo sync` pulls, commits, and pushes the plans repository.
