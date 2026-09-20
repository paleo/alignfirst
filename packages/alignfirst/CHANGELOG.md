# alignfirst

## 0.4.0

### Minor Changes

- 30b9db6: Moved to the `@alignfirst` npm scope. `alignfirst` itself stays unscoped, and the previous names are deprecated and receive no further releases.
  
  Replace the `@paleo/` prefix in your dependencies, then in the two scaffolded files that hardcode the scope as a path: the `include` of `./node_modules/@alignfirst/openclaw-test/docker-compose.yml` in `docker-compose.yml`, and `plugins.load.paths` under `node_modules/@alignfirst/openclaw-{discord,slack}-mock` in `openclaw.json`. A bumped dependency alone leaves `openclaw-test env up` failing on a missing Compose include, with the mock channels unloaded.

### Patch Changes

- 30b9db6: Added the `homepage` field pointing to https://alignfirst.paroi.tech, and a link to the product page in the README of each presented product.
- Updated dependencies [30b9db6]
- Updated dependencies [30b9db6]
  - @alignfirst/docmap@0.11.0

## 0.3.2

### Patch Changes

- ab0b032: Improved guidance for read-only question results and ticket catch-up context.

## 0.3.1

### Patch Changes

- fa78b2f: A failing git command now reports git's own message instead of pointing at output that was never printed, and names the subcommand that failed rather than a leading global option.
- fa78b2f: Renamed the container concept in every message and document to "work files": the conventions line now starts with `Work files:`, `sync` reports "Work files synchronized", `doctor` shows a "Work files" section, and the team repository is called the work-files repository. The `.plans` directory, the `plans` command and the `plans` config key keep their names.

## 0.3.0

### Minor Changes

- bf37177: `alignfirst sync` preserves conflicting documents separately, keeps published filenames stable, and retains original contents for supported rename and delete conflicts. Rebases that need manual resolution stop before pushing. Automatic archival retains recent files and archives stale sessions, including interrupted runs.

### Patch Changes

- bf37177: Made the no-agent-coauthoring convention override session instructions and cover generated-by footers.

## 0.2.1

### Patch Changes

- 348c407: Improved README.

## 0.2.0

### Minor Changes

- dda71dd: Detected side tickets from branches, used branch templates for ticket detection, accepted explicit ticket IDs outside the configured pattern, and validated `--next` filenames before reserving side tickets.

### Patch Changes

- dda71dd: Reworded the plans convention in `context`: dropped the misleading "keep it out of product commits" and explained why shared plans need `sync`.

## 0.1.1

### Patch Changes

- 6d72df2: Tightened merge conflict resolution and validation guidance.

## 0.1.0

### Minor Changes

- 44e1f9e: Initial release of the AlignFirst CLI.

### Patch Changes

- Updated dependencies [44e1f9e]
  - @alignfirst/docmap@0.10.0
