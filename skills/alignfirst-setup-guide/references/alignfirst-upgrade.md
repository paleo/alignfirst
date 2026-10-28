# Upgrade AlignFirst to v4

Migrate an existing AlignFirst v1, v2, or v3 project to the CLI-backed v4 skills. This workflow does
not install standalone docmap or workspace unless the user separately requests them.

The sections after [Route the Upgrade](#route-the-upgrade) are one-time migrations to later releases. Apply each one whose condition holds on the machine or in the project.

Commands are Unix-style. Adapt them for another shell.

For `.alignfirst.json`, workspace wrappers, old port slots or `aligndev worktree`, follow [Upgrading Multi-Stack Workspaces](upgrading-multi-stack-workspaces.md) before any procedure below. It supersedes the historical workspace conversions in this document and includes all-worktree resource accounting. Use `alignfirst.json`/`alignfirst.jsonc` for current project settings.

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
- v4: keep the current skills. Set `plans.autoArchive: true` in the selected `alignfirst.json`/`alignfirst.jsonc`; the
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

`aligndev` 0.23.0 reads its settings from `~/.alignfirst/aligndev.settings.json` only, and fails when only the old file exists. When `~/.alignfirst/aligndev.config.json` exists on the machine, migrate once:

1. Move it to `~/.alignfirst/aligndev.settings.json`. The schema is unchanged.
2. Run `aligndev guide code`, version 0.23.0 or later. It fails on an invalid file.

On an AlignDev OpenClaw host, the file and `~/.alignfirst/` are root-owned and immutable (`06-security-hardening.md`). The new maintenance wrapper unlocks the directory and `aligndev.settings.json`, never the old file, and reads the coding agent from the admin repository's `infra/openclaw/aligndev.settings.json`. The operator migrates during `update-assistant.md`, in this order:

1. In the admin repository, rename `infra/openclaw/aligndev.config.json` to `infra/openclaw/aligndev.settings.json`, and bring `seed.sh`, `bin/assistant-maintenance.sh`, `bin/backup.sh` and the docs to the current template. Commit, pull on the host, and reinstall the maintenance controls, as the first section of `update-assistant.md` does.
2. Install `aligndev` 0.23.0 through the npm packages section of `update-assistant.md`.
3. Remove the immutable flag from the old file, as root:

   ```sh
   sudo chattr -i /home/<service-user>/.alignfirst/aligndev.config.json
   ```

4. Remove the old file and re-seed in one `config` window. The seed installs `aligndev.settings.json` from the admin repository and validates it:

   ```sh
   sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- \
     bash -c 'rm ~/.alignfirst/aligndev.config.json && ~/seed/seed.sh'
   ```

5. Check the lock. The wrapper restores it on exit: `aligndev.settings.json` and `~/.alignfirst/` are root-owned and immutable again.

   ```sh
   sudo lsattr -d /home/<service-user>/.alignfirst /home/<service-user>/.alignfirst/aligndev.settings.json
   ```

## Convert AlignDev Launch Settings

When `aligndev.settings.json` contains direct `code.agent`, `code.defaultModel`, `code.models`, `code.skipPermissions` or `code.unset`, convert them manually to preserve the intended launch behavior. The CLI ignores retired fields with warnings on stderr and performs no automatic conversion. Recognized invalid values still fail. Preserve top-level `platform` and `projectsRoot`.

1. Choose a nonblank profile name. Move all former launch fields into `code.profiles.<name>`, including the required `agent`.
2. Set `code.profile` to that name for a global child selection. Alternatively, omit it to infer a sole matching profile, or set one profile's `default: true` per agent when several match.
3. If different accounts are intended, provision separate native stores and set each profile's `configDir` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `PI_CODING_AGENT_DIR`). `~/` uses the configured home; relative paths use the settings directory. Authenticate with the child's effective environment and cwd, applying profile `unset/env/configDir`, including HOME, PATH and credential routing. Native directory variables in `env` also select storage; a bare login in another shell may use another account. Never copy conversations or credentials between accounts to make resume work.
4. Review project registry selections and run `aligndev guide code --profile <name>`. Profile selection alone needs no companion or `.plans`. Obtain approval before changing any user's real settings or native account state.

For example, convert:

```json
{ "code": { "agent": "claude", "defaultModel": "opus", "unset": ["ANTHROPIC_API_KEY"] } }
```

to:

```json
{
  "code": {
    "profile": "claude-personal",
    "profiles": {
      "claude-personal": {
        "agent": "claude", "defaultModel": "opus", "unset": ["ANTHROPIC_API_KEY"]
      }
    }
  }
}
```

New-session precedence is explicit → project → global → automatic resolution. Resume inserts its recorded named profile before global resolution. Historical blank or missing profiles read as null and keep detected built-ins unless explicit/project/global selection replaces them; configured counts and flags do not trigger inference. No or multiple detected parents still fail, and the original transcript stays unchanged. A deleted recorded profile requires a higher-precedence selection. Resume requires the same agent and native conversation identity; Pi also requires its recorded real cwd. Current profile mappings resolve retained aliases, so their native targets can change. A disallowed retained model requires an explicit `--model`, never an automatic profile-default switch. Null keeps the native conversation model. Status remains readable when launch references or model defaults are no longer valid.

On an OpenClaw host, convert the private admin repository and protected settings together through controlled maintenance. Upgrade `seed.sh`, the inventory/policy helpers, maintenance/backup scripts and runbooks together. Install both helpers root-owned under `/opt/<service-user>/libexec` before invoking the new wrapper. Every deployment child and enabled explicit native quota source needs `configDir: null` for native defaults or a string for explicit storage; omission is invalid. Inventory all profiles, not just the global selection. Preserve existing strings during this migration; changing directory-selection mode requires separate operator confirmation. Run the rendered `update-assistant.md` sequence before restarting. For Pi, retain the approved writable `auth.json`/adjacent-lock exception and regenerate the protected launcher after npm-prefix hardening is restored. The deployment and harness profile migrations are separate integrations; do not install a profile-aware CLI over unconverted templates.

## Review AlignDev Native-Directory Selection

`configDir` accepts three states for coding profiles and enabled Claude/Codex quota sources:

- **Omitted:** inherit the caller's native directory variable unless `env`/`unset` changes it; otherwise native defaults apply. Use this for ordinary developer setup, including default quota sources such as `{ "source": "claude" }`.
- **Null:** deliberately remove `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR` for native-default directory behavior, even when the caller exports it.
- **String:** resolve and set the variable, including when the string names the default path. Keep custom strings for intentional account/configuration separation. `~/` uses the configured home; relative paths use the settings directory.

A string or null conflicts with the matching variable in `env` or `unset`. Null resets only directory routing, leaving HOME, PATH and API-key precedence intact. Explicit quota starts from the original caller environment and applies only its own settings; coding and explicit-quota resets are independent. Omitted quota for Claude/Codex uses the finalized coding environment. Pi requires an explicit quota source or `none`; disabled quota accepts no other fields, including `configDir: null`.

Preserve existing string selections during unrelated migrations, including the examples below. Before changing one, ask the user/operator to confirm whether it should remain explicit, inherit (ordinary CLI only), or force native defaults through null. On macOS, setting `CLAUDE_CONFIG_DIR` to the default path can select different Keychain credentials from leaving it unset. Changing modes does not promise to preserve the existing login. No settings rewrite, Keychain migration, credential transfer or automatic login is part of this feature. Authentication must reproduce the selected effective environment and cwd, including API-key routing.

For an OpenClaw deployment, every coding profile and enabled explicit quota source requires null or a string; generated defaults use null. Upgrade the CLI, inventory/policy helpers, settings and matching native-command runbooks together through controlled maintenance. Inventory `configDir` output remains an absolute filesystem path for seed, policy, maintenance and backup. Native commands read mode from the named profile/quota settings and unset the native variable for null or set its resolved value for a string, after login-shell initialization. A shared filesystem path does not establish the invocation mode.

When re-rendering Pi, replace `PI_CONFIG_DIR` with `PI_CONFIG_DIR_JSON` (raw JSON null or an encoded string) and `PI_CONFIG_DIR_DISPLAY` (human-facing text). Substitute `PI_QUOTA_JSON` as a raw JSON object, with null/string `configDir` for an enabled source or only `{ "source": "none" }`. Do not put quotes around raw JSON placeholders.

## Convert AlignDev Profile Defaults

When `aligndev.settings.json` contains `code.defaultProfiles`, convert it manually to preserve needed preferences. Any presence, including an empty or null map or a map alongside new flags, is ignored with a warning on stderr. The map never supplies defaults. Unknown keys at each fixed settings/profile/quota shape are also ignored with warnings; recognized invalid values and duplicate true flags still fail. Profile, environment and alias dictionaries remain maps. Neither the CLI nor the deployment inventory rewrites settings.

1. For each old entry, set `default: true` on its referenced matching-agent profile when a preference is needed. Omit the flag when that agent has only one profile. False and omitted have the same meaning.
2. Leave at most one true flag per agent. Different agents may each have a preference. A flag is per-agent selection metadata; `code.profile` remains the global named child choice.
3. Remove `code.defaultProfiles`. Keep profile names unchanged so project references and named resumes remain valid.
4. Validate with `aligndev guide code --profile <name>` for every profile. Obtain approval before editing real settings or native account state; the CLI never rewrites them.

Before:

```json
{
  "code": {
    "defaultProfiles": { "claude": "work", "pi": "solo" },
    "profiles": {
      "work": { "agent": "claude", "configDir": "~/.claude-work" },
      "personal": { "agent": "claude", "configDir": "~/.claude" },
      "solo": { "agent": "pi", "configDir": "~/.pi/agent" }
    }
  }
}
```

After:

```json
{
  "code": {
    "profiles": {
      "work": { "agent": "claude", "default": true, "configDir": "~/.claude-work" },
      "personal": { "agent": "claude", "configDir": "~/.claude" },
      "solo": { "agent": "pi", "configDir": "~/.pi/agent" }
    }
  }
}
```

For new sessions, help, guide and quota, automatic resolution selects the sole profile matching one detected parent, or its unique true flag among several matches. Without a match, it uses that parent's built-ins; another agent's profile never overrides it. Without a parent, exactly one total profile is inferable. Several detected kinds always require a named choice. Flags cannot resolve absent or ambiguous agent-kind detection.

Unique-profile inference is an intentional behavior change. New runs that previously used built-ins may now use configured native storage, models, environment and permission settings. Review those settings before launching.

Historical null/missing-profile resumes are separate: without an explicit/project/global replacement, they still detect the parent and use only built-ins, ignoring configured counts and flags. The new record keeps null and the original transcript remains unchanged. Named resumes keep their recorded name ahead of changed global settings or flags; a deleted recorded name requires an explicit or project replacement.

On an OpenClaw host, update the private admin repository and protected settings through controlled maintenance. Explicit valid `code.profile` remains mandatory even with one profile or a true flag. Preserve all native-store isolation and Pi authentication exceptions; upgrade the inventory helper and retain seed validation of every profile.

## Rename the AlignDev Message-Tool Topics

`aligndev` 0.29.0 replaces the `slack-message-tool` and `discord-message-tool` guide topics with `message-tool`, read through `aligndev guide --channel <slack|discord> message-tool`. The old topics fail. On an AlignDev OpenClaw host whose workspace `AGENTS.md` still names an old topic, migrate once during `update-assistant.md`:

1. In the admin repository, bring `infra/openclaw/workspace/AGENTS.md` to the current template. On a Discord deployment, also bring `infra/openclaw/seed/surface.sh`: it sets `session.dmScope` to `per-channel-peer`, so a DM no longer shares the session of the apps' Home conversation. Commit and pull on the host.
2. Install `aligndev` 0.29.0 through the npm packages section of `update-assistant.md`, then re-seed through the `config instructions` command in `configure-assistant.md`.

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

## Historical: Rename the Work-Files Folder Setting

The clean-break runbook supersedes this old-file transition on the current CLI; `plans.folder` is now rejected.

`alignfirst` 0.12.0 reads the project's folder in the work-files repository from `plans.repositoryFolder` in `.alignfirst.json`. It still reads the deprecated `plans.folder`, with a warning pointing here, and fails when both keys are present. Rename the key; the value stays. An older `alignfirst` rejects `plans.repositoryFolder`: rename it once every copy that reads the file runs 0.12.0. On an AlignDev OpenClaw host, the file lives in the admin repository: rename it there and re-seed.

## Historical: Move Workspace Ports to the Dev-Server

This describes the pre-manifest release transition. Do not execute it on the current CLI; use the clean-break runbook above.

`@alignfirst/workspace` 0.37.0 allocates the ports in the dev-server, at each workspace's first `dev setup`, and provisions infrastructure there. Migrate a project once when its `workspace.mjs` declares `ports` or `setupProfiles`, or when its `finalizeWorkspace` provisions infrastructure. The old wrapper assets are retired. The current [workspace blueprint](workspace-setup.md) documents manifests and project-owned commands.

1. Move `ports` to `dev-server.mjs` as a range. `first` is the old `base`, and `last` the old range end, `base + maxWorkspaces × perWorkspace − 1`, so `portRange` in `.alignfirst.json` stays valid. `perWorkspace` defaulted to the number of names. Rename `names` to `declare`; a `compute` function becomes the names it returned.
2. Move the files that carry ports from `gitignoredFiles` to `runFiles` in `dev-server.mjs`. Their `patch` receives `ports` as before.
3. Move the infrastructure from `finalizeWorkspace` to the dev-server's `setup`, and keep it idempotent: `dev setup --force` runs it again. Name every resource after the workspace. `finalizeWorkspace` keeps install and build, and returns nothing.
4. Remove `setupProfiles`, the profile checks in `preSetup`, and every `--profile remote` command. The run-file patches build the public URLs from `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST` ([Public URLs](workspace-setup.md#public-urls)). A deployment that used the public-IP profile sets `REMOTE_DEV_HOST`.
5. Give each spawn server the name of its port, such as `port: "frontend"`.
6. Offer to pin the main worktree's current ports, read from its run files, to keep them: each becomes the `mainWorktree` of its `declare` entry, as `{ name, mainWorktree }`. Linked workspaces get new ports at their next start. Their infrastructure, already provisioned, follows a moved port only when a callback `start` recreates it, as `docker compose up -d` does; otherwise run `dev setup --force` in the workspace.
7. Make `purgeInfrastructure` tear down by the workspace name ([Teardown by name](workspace-setup.md#teardown-by-name)). Keep reading `purgeData` while existing workspaces carry one: the old `finalizeWorkspace` returned it, and their entries still pass it.
8. In the workspaces section of `AGENTS.md` and `DEVELOPERS.md`, say that ports and infrastructure arrive with the first `dev` or `dev setup` ([Agent Instructions](workspace-setup.md#agent-instructions)).

On an AlignDev OpenClaw host with the dev-server gateway, `REMOTE_DEV_DOMAIN` already comes from `environment.d/common.conf`. A project needs no remote setup step anymore.

## Historical: Declare Workspace Ports

`@alignfirst/workspace` 0.38.0 refuses `ports.names` and `ports.mainWorktree` in `dev-server.mjs`. Migrate the `ports` group once:

1. Rename `names` to `declare`.
2. Turn each pin of `mainWorktree` into an entry `{ name, mainWorktree }` in `declare`, then remove the `mainWorktree` map.
3. Optionally, give an entry a `range` when something outside the repository enumerates its port for every workspace, such as an OAuth callback URL in a provider's allowlist ([Port range](workspace-setup.md#port-range)).

```js
// Before
ports: { first: 8100, last: 8199, names: ["server", "frontend"], mainWorktree: { frontend: 8100 } },
// After
ports: { first: 8100, last: 8199, declare: ["server", { name: "frontend", mainWorktree: 8100 }] },
```

## Historical: Declare the Run-File Inputs

`@alignfirst/workspace` 0.39.0 rewrites an existing run file at a start only when the ports or the run-file inputs changed since its last write. An explicit `dev setup` still rewrites them all. Migrate once when a run-file patch or `content` function reads a value besides `ports`, such as `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST`. Return those values from `runFilesInputs` in `dev-server.mjs`, as the former wrapper asset did. Without it, a start keeps the values of the last write.

## Update the Docmap Snippet

Version 0.48.0 of this guide asks for docmap once per session. When an `AGENTS.md` or `CLAUDE.md` has a `Docmap - Seek Documentation` section whose body says "Mandatory for every task", replace that body with the one in [Agent Instructions](docmap-setup.md#agent-instructions). Keep the heading and the project's docmap command.
