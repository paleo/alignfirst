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

1. **Pre-flight checks.** Keep them proportionate to the change; all must pass before proceeding.
   - Run `npm run lint:fix`, `npm run build` and `npm run typecheck`.
   - Run `npm test --workspace <name>` for each package the branch changes. Skip a package whose tests already passed on its current code.
   - Leave the full unit suite and the integration suites of `pi-background`, `workspace` and `aligndev` to the CI.
   - The CI lacks the three suites below. Run one only when the branch changes the code it covers:

     | Changed code | Check |
     | --- | --- |
     | `scripts/`, `skills/aligndev-openclaw-setup/` or `packages/aligndev/src/config.ts` | `npm run test:deployment-templates` |
     | `packages/service-openclaw-plugin` or an OpenClaw channel mock package | `npm run test:integration --workspace @alignfirst/service-openclaw-plugin` |
     | `aligndev-openclaw-tests/` | `npm test --prefix aligndev-openclaw-tests` |
2. **Ensure a changeset exists** when the branch touches `packages/`. Check for at least one changeset file in `.changeset/` (excluding `README.md`); if none exists, create one following [writing-a-changeset.md](writing-a-changeset.md), and include it in the commit.
3. **Commit and push.** Commit any uncommitted changes, including files modified by `lint:fix`. Then push the branch.
4. **Generate the PR description.** Use `alignfirst` to find the ticket directory. If a description file (`*-description.md`) already exists **and** is the last file in the directory (no further work was done after it), use its content directly. Otherwise, run `npx -y alignfirst guide description` and follow it. Use the description body as the PR description and the suggested commit message as the PR title.
5. **Create the PR** with `gh pr create`. The title follows the commit convention — conventional commits without the ticket ID, e.g. `feat: add new feature`:

   ```sh
   gh pr create \
     --title "feat: add new feature" \
     --body "$description" \
     --base main
   ```

The CI is the gate for the full unit suite and the integration suites. Report its checks as pending; do not wait for them.

Pull requests are squash-merged, so the PR title becomes the commit subject on `main`.

**Important:** Never create a PR without explicit user request.
