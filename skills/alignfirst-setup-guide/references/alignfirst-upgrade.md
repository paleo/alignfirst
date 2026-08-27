# Upgrade AlignFirst to v3

Migrate an existing AlignFirst v1 or v2 project, then install the current AlignFirst skills. This
workflow does not install docmap or workspace unless the user separately requests them.

Commands are Unix-style. Adapt them for another shell.

## Preflight

1. Verify the git working tree is clean immediately before mutations.
2. Use the existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` when neither exists.
3. Preserve the project's ticket, commit, default-branch, and other local conventions. The current
   setup reference will reconcile them after legacy cleanup.

## Detect the Installed Version

Detect v1 from `_docs/alignfirst/`, `_docs/vibe-flow/`, or `_docs/ai-workflow/`.

Detect v2 from `alignfirst/SKILL.md` under a canonical project skill root such as `.agents/skills/`,
`.claude/skills/`, `.codex/skills/`, `.github/skills/`, `.cursor/skills/`, `.gemini/skills/`, or
`.agent/skills/`. Also inspect `skills-lock.json` through the current skills CLI when present. Ignore
dependencies and generated output.

- For v1, follow [alignfirst-upgrade-from-v1.md](alignfirst-upgrade-from-v1.md).
- For v2, follow [alignfirst-upgrade-from-v2.md](alignfirst-upgrade-from-v2.md).
- If neither exists, use [alignfirst-skills-setup.md](alignfirst-skills-setup.md) as a fresh setup.

After the version-specific migration, always follow
[alignfirst-skills-setup.md](alignfirst-skills-setup.md) to install the current content skill and all
seven commands, establish `.plans`, and reconcile project instructions.
