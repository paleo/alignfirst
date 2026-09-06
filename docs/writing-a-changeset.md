---
title: Writing a Changeset
summary: How to author a Changesets file — identify packages, pick the bump, write the entry.
read_when:
  - writing a changeset
  - versioning a package change
---

# Writing a Changeset

Write the file directly. `npm run changeset` is the interactive equivalent, for humans.

1. **Identify modified packages.** Map changed file paths to their workspace packages:
   `packages/<name>/` → `@paleo/<name>`, except `packages/alignfirst/` → `alignfirst`. Only include
   packages with actual source changes. Changes confined to `skills/`,
   `alignfirst-developer-tests/`, `alignfirst-developer.md`, or `docs/` release nothing and need no
   changeset.

   ```sh
   git diff main --name-only
   git status --short        # include uncommitted files
   ```

2. **Gather context from the plan directory.** Run `alignfirst ticket <id>` to find the plan
   directory. Read the summary files (`*-summary.md`) and spec files to write a meaningful
   description.

3. **Determine the bump type** for each package:
   - `patch` — bug fixes, refactors, internal changes
   - `minor` — new features, new API surface
   - `major` — breaking changes

4. **Write the changeset file** in `.changeset/`, with a short kebab-case name (e.g.
   `.changeset/alignfirst-new-command.md`):

   ```markdown
   ---
   "alignfirst": minor
   ---

   One-line summary of the change (past tense).
   ```

The entry becomes the package's changelog line, so write it for a consumer of that package.

Consumer repositories pin these packages with `~`, so a published change reaches them only when they bump the range.
