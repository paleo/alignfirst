# Upgrade AlignFirst to v4

Migrate an existing AlignFirst v1, v2, or v3 project to the CLI-backed v4 skills. This workflow does
not install standalone docmap or workspace unless the user separately requests them.

Commands are Unix-style. Adapt them for another shell.

## Preflight

1. Verify the git working tree is clean immediately before mutations.
2. Use the existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` when neither exists.
3. Preserve the project's commit, default-branch, and other local conventions.

## Detect the Installed Version

- **v4:** the `alignfirst` skill has `metadata.version` beginning with `4.` or is a stub that runs
  `alignfirst guide`. This signal wins even when legacy npm script names remain. A script that runs
  `alignfirst` is not evidence of v3.
- **v3:** the eight skills contain their full protocol content. Detect a `references/` directory
  under the `alignfirst` skill or `metadata.version` beginning with `3.`. When v4 is absent, also
  detect v3 from `@paleo/plans-share` or an active command that invokes `plans-share`.
- **v2:** `alignfirst/SKILL.md` exists under a canonical project skill root, but the skill has no
  `references/` directory and its metadata predates v3.
- **v1:** `_docs/alignfirst/`, `_docs/vibe-flow/`, or `_docs/ai-workflow/` exists.

Apply explicit skill-version and stub signals before legacy file or command footprints.

Inspect `skills-lock.json` through the current skills CLI when present. Ignore dependencies and
generated output.

## Route the Upgrade

- v1: follow [alignfirst-upgrade-from-v1.md](alignfirst-upgrade-from-v1.md).
- v2: follow [alignfirst-upgrade-from-v2.md](alignfirst-upgrade-from-v2.md).
- v3: follow [alignfirst-upgrade-from-v3.md](alignfirst-upgrade-from-v3.md).
- v4: keep the current skills. Set `plans.autoArchive: true` in an existing `.alignfirst.json`; the
  user can remove it after the upgrade to opt out. When legacy `plans-share` artifacts remain, apply
  the cleanup, command sweep, and verification sections of the v3 upgrade.
- No detected installation: use [alignfirst-skills-setup.md](alignfirst-skills-setup.md).

The v1 and v2 migrations preserve project knowledge and remove their legacy layouts. After either
one, continue with the v3 migration for the CLI installation and project config.

## Move the Home Directory

`alignfirst` 0.6.0 and `aligndev` 0.20.0 read their files from `~/.alignfirst/` only. `alignfirst` 0.7.0 reads the companion registry from `~/.alignfirst/companions/registry.json`. When `~/.config/alignfirst/` or a `companions.json` exists on the machine, migrate once:

1. Move `aligndev.config.json` from `~/.config/alignfirst/` to `~/.alignfirst/`. A relative `projectsRoot` now resolves against `~/.alignfirst/`.
2. When `companions.json` has a `root`, move the companion directories it held to `~/.alignfirst/companions/`, or make `~/.alignfirst/companions` a symlink to that directory.
3. Move `companions.json`, from `~/.config/alignfirst/` or `~/.alignfirst/`, to `~/.alignfirst/companions/registry.json`. Remove `root` from it; the registry no longer accepts it.
4. Remove `~/.config/alignfirst/`, then run `alignfirst doctor` in a project that has a companion.

On an AlignDev OpenClaw host, `~/.alignfirst/` and its files are immutable. The operator unlocks them, moves the files, and gives `registry.json` to the service account, which edits it. The operator then removes `infra/openclaw/companions.json` from the admin repository, re-seeds, and locks `~/.alignfirst/` as `06-security-hardening.md` describes.
