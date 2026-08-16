---
title: Creating a Pull Request
summary: GitHub PR procedure — pre-flight checks, changeset, commit/push, description, gh.
read_when:
  - creating a pull request
  - pushing code for review
---

# GitHub — Creating a Pull Request

Use **gh** (the GitHub CLI) for remote operations. PR and MR are equivalent terms.

When the user asks to create a PR:

1. **Pre-flight checks.** Run `npm run lint:fix`, `npm run build`, and `npm test`. All must pass before proceeding.
2. **Ensure a changeset exists** when the branch touches `packages/`. Check for at least one changeset file in `.changeset/` (excluding `README.md`); if none exists, create one following [writing-a-changeset.md](writing-a-changeset.md), and include it in the commit.
3. **Commit and push.** Commit any uncommitted changes, including files modified by `lint:fix`. Then push the branch.
4. **Generate the PR description.** Use `alignfirst` to find the plan directory. If a description file (`*-description.md`) already exists **and** is the last file in the directory (no further work was done after it), use its content directly. Otherwise, run the `aldescription` protocol from the `alignfirst` skill. Use the description body as the PR description and the suggested commit message as the PR title.
5. **Create the PR** with `gh pr create`. The title follows the commit convention — conventional commits without the ticket ID, e.g. `feat: add new feature`:

   ```sh
   gh pr create \
     --title "feat: add new feature" \
     --body "$description" \
     --base main
   ```

Pull requests are squash-merged, so the PR title becomes the commit subject on `main`.

**Important:** Never create a PR without explicit user request.
