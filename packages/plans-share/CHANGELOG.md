# @paleo/plans-share

## 0.6.1

### Patch Changes

- 801309f: Published from CI with an npm provenance attestation, verifiable with `npm audit signatures`.

## 0.6.0

### Minor Changes

- `check` now reports the mode of `.plans` instead of requiring a plans repository. It exits 1 only when `.plans` is unusable. Breaking: `check` used to fail on a local `.plans`.

## 0.5.0

### Minor Changes

- b40afe9: Local plans mode: `sync` now succeeds when `.plans` is a plain local directory.

## 0.4.0

### Minor Changes

- Renamed from `@paleo/plans-repo`: the bin is now `plans-share`; update the `plans:setup` and `plans:sync` scripts accordingly. The `sync` command now reports whether local changes were sent.

## 0.3.0

### Minor Changes

- 21d52a7: New `plans-repo check` command: verifies that `.plans` is linked to a team plans repository, and exits 1 with guidance otherwise.

## 0.2.0

### Minor Changes

- 6d62bcf: `plans-repo setup` no longer clones the plans repository: point it at an existing clone (clone it yourself, with your own SSH configuration). The `--repo` option is removed — update the `plans:setup` npm script to `plans-repo setup --folder <name>` and document the repository URL in the instruction file.

## 0.1.0

### Minor Changes

- 60afd89: New `plans-repo` CLI: share the `.plans` directory through a dedicated team plans repository. `plans-repo setup <dir> --repo <url> --folder <name>` clones (or reuses) the plans repository and links `.plans` to the project's folder inside it, migrating any existing content. `plans-repo sync` pulls, commits, and pushes the plans repository.
