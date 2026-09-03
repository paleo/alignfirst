# Upgrade AlignFirst to v4

Migrate an existing AlignFirst v1, v2, or v3 project to the CLI-backed v4 skills. This workflow does
not install standalone docmap or workspace unless the user separately requests them.

Commands are Unix-style. Adapt them for another shell.

## Preflight

1. Verify the git working tree is clean immediately before mutations.
2. Use the existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` when neither exists.
3. Preserve the project's commit, default-branch, and other local conventions.

## Detect the Installed Version

- **v1:** `_docs/alignfirst/`, `_docs/vibe-flow/`, or `_docs/ai-workflow/` exists.
- **v2:** `alignfirst/SKILL.md` exists under a canonical project skill root, but the skill has no
  `references/` directory and its `metadata.version` is not `3.x`.
- **v3:** the eight skills contain their full protocol content. Detect a `references/` directory
  under the `alignfirst` skill, `metadata.version` beginning with `3.`,
  [the retired plans package](alignfirst-upgrade-from-v3.md#remove-the-plans-package), or its setup
  and sync scripts.

Inspect `skills-lock.json` through the current skills CLI when present. Ignore dependencies and
generated output.

## Route the Upgrade

- v1: follow [alignfirst-upgrade-from-v1.md](alignfirst-upgrade-from-v1.md).
- v2: follow [alignfirst-upgrade-from-v2.md](alignfirst-upgrade-from-v2.md).
- v3: follow [alignfirst-upgrade-from-v3.md](alignfirst-upgrade-from-v3.md).
- No detected installation: use [alignfirst-skills-setup.md](alignfirst-skills-setup.md).

The v1 and v2 migrations preserve project knowledge and remove their legacy layouts. After either
one, continue with the v3 migration for the CLI installation and project config.
