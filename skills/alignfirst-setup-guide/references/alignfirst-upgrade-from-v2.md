# Upgrade from AlignFirst v2

Remove the v2 agent-skills installation while preserving project-specific instructions and custom
skills. Continue with the current setup reference after these steps.

Commands are Unix-style. Adapt them for another shell.

## Locate the Installation

Find every project skill root containing `alignfirst/SKILL.md`. Common roots are `.agents/skills/`,
`.claude/skills/`, `.codex/skills/`, `.github/skills/`, `.cursor/skills/`, `.gemini/skills/`, and
`.agent/skills/`. Ignore dependencies and generated output.

When the current skills CLI owns the installation, use
`npx -y skills remove alignfirst --yes </dev/null>` so it removes canonical links and updates lock
state. Otherwise remove only the detected legacy `alignfirst` and
`technical-documentation-authoring` directories. Do not delete unrelated skills.

## Remove Legacy Commands

Remove only known AlignFirst command files from existing project directories:

- `.claude/commands/{al,alspec,alplan,aldescription,almerge,alreview,alread}.md`
- `.codex/prompts/{al,alspec,alplan,aldescription,almerge,alreview,alread}.md`
- `.github/prompts/{al,alspec,alplan,aldescription,almerge,alreview,alread}.prompt.md`
- `.cursor/commands/{al,alspec,alplan,aldescription,almerge,alreview,alread}.md`
- `.agent/workflows/{al,alspec,alplan,aldescription,almerge,alreview,alread}.md`

These paths are legacy cleanup targets, not current installation locations.

## Migrate Plans and Instructions

1. If only `_plans/` exists, rename it to `.plans/`. If both exist, move `_plans/` to
   `.plans/_plans-archives/`. Remove `.plans/.gitkeep`.
2. Replace repository references to `_plans` with `.plans`.
3. Remove `_plans` ignore rules. Replace the old shared-file block (`.plans/**`, `!.plans/**/`, and
   `!.plans/**/*.shared.md`) with `.plans`. Untrack committed `*.shared.md` files and report them.
4. In `AGENTS.md` or `CLAUDE.md`, preserve project conventions while removing references to deleted
   v2 skills and legacy paths. Remove sections that become empty.

## Preserve Remaining Custom Skills

List the remaining directories under every detected project skill root. If custom skills remain,
follow [docmap-migrate-skills.md](docmap-migrate-skills.md) only when the user wants to migrate them;
otherwise leave them untouched.

## Finish the Upgrade

Follow [alignfirst-skills-setup.md](alignfirst-skills-setup.md). Install the current `alignfirst`
content skill and all seven command skills for the requested agent and scope, then reconcile `.plans`,
`.gitignore`, and project instructions.

Summarize the removed legacy files, plan migration, preserved custom skills, and the scope and agents
that received the current AlignFirst skills.
