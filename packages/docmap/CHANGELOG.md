# @paleo/docmap

## 0.7.2

### Patch Changes

- Improve the bare `docmap` command when the CLI is run as a global binary.

## 0.7.1

### Patch Changes

- 592cd51: A bare `docmap` now always prints the command list, even for large doc trees. Previously the command list appeared only on projects with fewer than 20 documents, hiding it from exactly the larger projects where navigating with the CLI matters most.

## 0.7.0

### Minor Changes

- Add a `-v`/`--version` flag that prints the docmap version.

## 0.6.4

### Patch Changes

- 22ba811: Rename the example placeholders in the help output and README from `topic-a`/`topic-b` to `dir-a`/`dir-b`.

## 0.6.3

### Patch Changes

- 1c6c16b: Improved the README setup instructions.

## 0.6.2

### Patch Changes

- Render help command lists inside fenced code blocks, and drop the listing "Tip" line.

## 0.6.1

### Patch Changes

- Clarify the help hint: run `--guide` before writing a new document or editing an existing one.

## 0.6.0

### Minor Changes

- 4396c78: Self-documenting CLI: add `--help`, `--guide`, and `--search`. Bare run lists recursively for small doc sets. No-lockfile fallback now suggests the package-runner form.

## 0.5.1

### Patch Changes

- Fixed escaping directory.

## 0.5.0

### Minor Changes

- 18f400e: Positional path arguments replace `--dir` / `--read`.

## 0.4.4

### Patch Changes

- Upgraded package metadata

## 0.4.3

### Patch Changes

- Improved documentation

## 0.4.2

### Patch Changes

- First version in changelog
