# Upgrade AlignFirst to v4

Migrate an existing AlignFirst v1, v2, or v3 project to the CLI-backed v4 skills. This workflow does
not install standalone docmap or workspace unless the user separately requests them.

The sections after [Route the Upgrade](#route-the-upgrade) are one-time migrations to later releases. Apply each one whose condition holds on the machine or in the project.

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

## Rename the AlignDev Settings

`aligndev` 0.23.0 reads its settings from `~/.alignfirst/settings.json` only, and fails when only the old file exists. When `~/.alignfirst/aligndev.config.json` exists on the machine, migrate once:

1. Move it to `~/.alignfirst/settings.json`. The schema is unchanged.
2. Run `aligndev guide code`, version 0.23.0 or later. It fails on an invalid file.

On an AlignDev OpenClaw host, the file and `~/.alignfirst/` are root-owned and immutable (`06-security-hardening.md`). The new maintenance wrapper unlocks the directory and `settings.json`, never the old file, and reads the coding agent from the admin repository's `infra/openclaw/settings.json`. The operator migrates during `update-assistant.md`, in this order:

1. In the admin repository, rename `infra/openclaw/aligndev.config.json` to `infra/openclaw/settings.json`, and bring `seed.sh`, `bin/assistant-maintenance.sh`, `bin/backup.sh` and the docs to the current template. Commit, pull on the host, and reinstall the maintenance controls, as the first section of `update-assistant.md` does.
2. Install `aligndev` 0.23.0 through the npm packages section of `update-assistant.md`.
3. Remove the immutable flag from the old file, as root:

   ```sh
   sudo chattr -i /home/<service-user>/.alignfirst/aligndev.config.json
   ```

4. Remove the old file and re-seed in one `config` window. The seed installs `settings.json` from the admin repository and validates it:

   ```sh
   sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- \
     bash -c 'rm ~/.alignfirst/aligndev.config.json && ~/seed/seed.sh'
   ```

5. Check the lock. The wrapper restores it on exit: `settings.json` and `~/.alignfirst/` are root-owned and immutable again.

   ```sh
   sudo lsattr -d /home/<service-user>/.alignfirst /home/<service-user>/.alignfirst/settings.json
   ```

## Convert the Companion Registry

`alignfirst` 0.11.0 reads the companion registry as `{ "projects": … }`, and each entry names its companion directory. When `~/.alignfirst/companions/registry.json` has a top-level `paths`, every command fails with an error pointing here. Convert it once:

1. Rename `paths` to `projects`. The keys stay.
2. Give each entry a `dir`: the companion's current directory name under `~/.alignfirst/companions/`, so the companion stays put. The old versions derived that name from the real path of the project's main worktree: relative to the home directory, or the absolute path without its leading `/` outside it, with every `/` replaced by `_`.
3. Move the entry's item settings into `items`. `true` becomes `"companion"`, `false` becomes `"project"`, and `"auto"` is dropped. `_aligndev: true` becomes `"companion"`, and `_aligndev: false` is dropped. Omit an empty `items`.
4. Run `alignfirst doctor` in a project that has a companion.

For example:

```json
{ "paths": { "~/projects/team-app": { ".plans": false, "_aligndev": true } } }
```

becomes:

```json
{
  "projects": {
    "~/projects/team-app": {
      "dir": "projects_team-app",
      "items": { ".plans": "project", "_aligndev": "companion" }
    }
  }
}
```

An older `alignfirst` fails on the new shape: update every copy that reads the registry, such as an `npx` cache or another project's pinned dependency.

On an AlignDev OpenClaw host, the registry stays service-owned. Convert it as the service account, once `update-assistant.md` has installed `alignfirst` 0.11.0.

## Move Workspace Ports to the Dev-Server

`@alignfirst/workspace` 0.37.0 allocates the ports in the dev-server, at each workspace's first `dev setup`, and provisions infrastructure there. Migrate a project once when its `workspace.mjs` declares `ports` or `setupProfiles`, or when its `finalizeWorkspace` provisions infrastructure. The [workspace blueprint](workspace-setup.md) and the [workspace.mjs](../assets/workspace.mjs) and [dev-server.mjs](../assets/dev-server.mjs) assets show the target shape.

1. Move `ports` to `dev-server.mjs` as a range. `first` is the old `base`, and `last` the old range end, `base + maxWorkspaces × perWorkspace − 1`, so `portRange` in `.alignfirst.json` stays valid. `perWorkspace` defaulted to the number of names. Keep `names`; a `compute` function becomes the names it returned.
2. Move the files that carry ports from `gitignoredFiles` to `runFiles` in `dev-server.mjs`. Their `patch` receives `ports` as before.
3. Move the infrastructure from `finalizeWorkspace` to the dev-server's `setup`, and keep it idempotent: `dev setup --force` runs it again. Name every resource after the workspace. `finalizeWorkspace` keeps install and build, and returns nothing.
4. Remove `setupProfiles`, the profile checks in `preSetup`, and every `--profile remote` command. The run-file patches build the public URLs from `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST` ([Public URLs](workspace-setup.md#public-urls)). A deployment that used the public-IP profile sets `REMOTE_DEV_HOST`.
5. Give each spawn server the name of its port, such as `port: "frontend"`.
6. Offer `ports.mainWorktree` with the main worktree's current ports, read from its run files, to keep them. Linked workspaces get new ports at their next start. Their infrastructure, already provisioned, follows a moved port only when a callback `start` recreates it, as `docker compose up -d` does; otherwise run `dev setup --force` in the workspace.
7. Make `purgeInfrastructure` tear down by the workspace name ([Teardown by name](workspace-setup.md#teardown-by-name)). Keep reading `purgeData` while existing workspaces carry one: the old `finalizeWorkspace` returned it, and their entries still pass it.
8. In the workspaces section of `AGENTS.md` and `DEVELOPERS.md`, say that ports and infrastructure arrive with the first `dev` or `dev setup` ([Agent Instructions](workspace-setup.md#agent-instructions)).

On an AlignDev OpenClaw host with the dev-server gateway, `REMOTE_DEV_DOMAIN` already comes from `environment.d/common.conf`. A project needs no remote setup step anymore.

## Update the Docmap Snippet

Version 0.48.0 of this guide asks for docmap once per session. When an `AGENTS.md` or `CLAUDE.md` has a `Docmap - Seek Documentation` section whose body says "Mandatory for every task", replace that body with the one in [Agent Instructions](docmap-setup.md#agent-instructions). Keep the heading and the project's docmap command.
