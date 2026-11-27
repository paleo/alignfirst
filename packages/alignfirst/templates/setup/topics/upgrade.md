# Upgrade AlignFirst

Migrate legacy instructions, full-content skills and `plans-share` to CLI-backed skills. This workflow installs standalone Docmap or workspaces only when separately requested.

The sections after "Route the Upgrade" are one-time migrations. Apply each one whose detected files or settings match.

Commands are Unix-style. Adapt them for another shell.

For `.alignfirst.json`, workspace wrappers, old port slots or `aligndev worktree`, follow `{{CMD}} setup guide upgrade-workspaces` before any procedure below. It supersedes the historical workspace conversions in this topic and includes all-worktree resource accounting. Current project settings use `alignfirst.json` or `alignfirst.jsonc`.

## Preflight

1. Verify the Git working tree is clean immediately before mutations.
2. Use the existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` when neither exists.
3. Preserve the project's commit, default-branch and other local conventions.

## Detect the Installed Layout

The `Legacy` item of the `{{CMD}} setup` report lists the detected legacy signals with their upgrade topic. The report does not detect a standalone project skill, and it finds full-content skills only in global skill roots. Tell the layouts apart with these definitions:

- **CLI-backed skills:** the `alignfirst` skill is a stub that runs `alignfirst guide`. This signal wins even when legacy npm script names remain. A script that runs `alignfirst` is not evidence of full-content skills.
- **Full-content protocol skills:** the protocol skills contain their full instructions, with a `references/` directory under `alignfirst`. Without CLI-backed stubs, `@paleo/plans-share` or an active `plans-share` command also selects this cleanup route.
- **Standalone project skill:** `alignfirst/SKILL.md` exists under a canonical project skill root, without CLI-backed routing or a `references/` directory.
- **Legacy documentation:** `_docs/alignfirst/`, `_docs/vibe-flow/` or `_docs/ai-workflow/` exists.

Inspect the actual skill content before relying on legacy command footprints.

When `skills-lock.json` is present, inspect it through the current skills CLI. Ignore dependencies and generated output.

## Route the Upgrade

- Legacy documentation: follow `{{CMD}} setup guide upgrade-v1`.
- Standalone project skill: follow `{{CMD}} setup guide upgrade-v2`.
- Full-content protocol skills or `plans-share`: follow `{{CMD}} setup guide upgrade-v3`.
- Retired workspace files or registries: follow `{{CMD}} setup guide upgrade-workspaces`.
- AlignDev settings with `platform`, `code.profile`, `portRange` or a profile `agent`, or a `.alignfirst-projects.json` marker: apply "Convert AlignDev Harness Settings" below.
- AlignDev settings with a `pi` profile: apply "Declare AlignDev Pi Models" below.
- CLI-backed skills: keep the current skills. Set `plans.autoArchive: true` in the selected `alignfirst.json` or `alignfirst.jsonc`; the user can remove it after the upgrade to opt out. If `plans-share` artifacts remain, apply the cleanup, command sweep and check of `{{CMD}} setup guide upgrade-v3`.
- `assistantInstructionsFile` or `developerInstructions` in the selected `alignfirst.json` or `.jsonc`: apply "Rename the Assistant Guide" below.
- No detected installation: follow `{{CMD}} setup guide protocols`.

The documentation and standalone-skill migrations preserve project knowledge before removing legacy layouts. Both then continue with `{{CMD}} setup guide upgrade-v3`.

## Keep the Service AlignFirst Home Writable

On an AlignDev OpenClaw host, the entire service `~/.alignfirst/` tree must stay service-owned and writable: the directory itself, AlignDev settings, companions and future descendants. Remove legacy immutable and append-only flags through the "Writable AlignFirst home" section of the admin repository's generated `docs/installations/06-security-hardening.md`. Update the maintenance controls before migrating; older wrappers can restore the retired locks. Every historical migration below preserves this writable state. Protections outside this tree remain unchanged, including Pi's existing writable authentication exception.

## Move the Home Directory

Current CLIs read their home files from `~/.alignfirst/` and the companion registry from `~/.alignfirst/companions/registry.json`. When `~/.config/alignfirst/` or a `companions.json` exists on the machine, migrate once:

1. Move `aligndev.config.json` from `~/.config/alignfirst/` to `~/.alignfirst/`. A relative `projectsRoot` now resolves against `~/.alignfirst/`.
2. When `companions.json` has a `root`, move the companion directories it held to `~/.alignfirst/companions/`, or make `~/.alignfirst/companions` a symlink to that directory.
3. Move `companions.json`, from `~/.config/alignfirst/` or `~/.alignfirst/`, to `~/.alignfirst/companions/registry.json`. Remove `root` from it; the registry no longer accepts it.
4. Remove `~/.config/alignfirst/`, then run `{{CMD}} doctor` in a project that has a companion.

On an AlignDev OpenClaw host, first apply "Keep the Service AlignFirst Home Writable". The operator moves the files, preserves service ownership and writability throughout `~/.alignfirst/`, removes `infra/openclaw/companions.json` from the admin repository, and re-seeds. Do not restore the old locks.

## Rename the AlignDev Settings

AlignDev reads `~/.alignfirst/aligndev.settings.json` and fails when only the old `~/.alignfirst/aligndev.config.json` exists. When that old file is present, migrate once:

1. Move it to `~/.alignfirst/aligndev.settings.json`. The schema is unchanged.
2. Run current `aligndev guide code`. It fails on an invalid file.

On an AlignDev OpenClaw host, the operator migrates during `update-assistant.md`, in this order:

1. In the admin repository, rename `infra/openclaw/aligndev.config.json` to `infra/openclaw/aligndev.settings.json`, and bring `seed.sh`, the inventory and policy helpers, the maintenance and backup scripts and the runbooks to the current template. Commit, pull on the host, and reinstall the maintenance controls as `update-assistant.md` describes.
2. Apply "Keep the Service AlignFirst Home Writable", including the old settings file.
3. Install a current `aligndev` through the npm packages section of `update-assistant.md`.
4. Remove the old file and re-seed in one `config` window. The seed installs `aligndev.settings.json` from the admin repository and validates it:

   ```sh
   sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- \
     bash -c 'rm ~/.alignfirst/aligndev.config.json && ~/seed/seed.sh'
   ```

5. Verify service ownership, writability and the absence of immutable or append-only flags throughout `~/.alignfirst/`, with the checks of the "Writable AlignFirst home" section in the generated `docs/installations/06-security-hardening.md`. Maintenance must leave this tree writable.

## Convert AlignDev Launch Settings

When `aligndev.settings.json` contains direct `code.agent`, `code.defaultModel`, `code.models`, `code.skipPermissions` or `code.unset`, convert them manually to preserve the intended launch behavior. The CLI ignores retired fields with warnings on stderr and performs no automatic conversion. Recognized invalid values still fail. Preserve top-level `projectsRoot`.

1. Choose a nonblank profile name. Move all former launch fields into `code.profiles.<name>`; `code.agent` becomes the required `harness`.
2. A session of the same harness selects that profile as the assistant's profile. To select it from another harness, follow step 2 of "Convert AlignDev Harness Settings".
3. If different accounts are intended, provision separate native stores and set each profile's `configDir` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR`). `~/` uses the configured home; relative paths use the settings directory. Authenticate with the agent's effective environment and cwd, applying the profile's `unset`, `env` and `configDir`, including HOME, PATH and credential routing. Native directory variables in `env` also select storage; a bare login in another shell may use another account. Never copy conversations or credentials between accounts to make resume work.
4. Review project registry selections and run `aligndev guide code --profile <name>`. Profile selection alone needs no companion or `.plans`. Obtain approval before changing any user's real settings or native account state.

For example, convert:

```json
{ "code": { "agent": "claude", "defaultModel": "opus", "unset": ["ANTHROPIC_API_KEY"] } }
```

to:

```json
{
  "code": {
    "profiles": {
      "claude-personal": {
        "harness": "claude", "defaultModel": "opus", "unset": ["ANTHROPIC_API_KEY"]
      }
    }
  }
}
```

New-session precedence is explicit → project → recorded named profile on resume → the assistant's profile → the built-ins of the assistant's harness, as `{{CMD}} setup guide coding-agent-assistant` details. Historical blank or missing profiles read as null and use the built-ins of the assistant's harness unless an explicit or project selection replaces them. An OpenClaw or unrecognized harness still fails there, and the original transcript stays unchanged. A deleted recorded profile requires a higher-precedence selection. Resume requires the same agent and native conversation identity; Pi also requires its recorded real cwd. Current profile mappings resolve retained aliases, so their native targets can change. A disallowed retained model requires an explicit `--model`, never an automatic profile-default switch. Null keeps the native conversation model. Status remains readable when launch references or model defaults are no longer valid.

On an OpenClaw host, convert the private admin repository and the deployed settings together through controlled maintenance, preserving the writable service AlignFirst home (see "Keep the Service AlignFirst Home Writable"). Upgrade `seed.sh`, the inventory and policy helpers, the maintenance and backup scripts and the runbooks together. Install both helpers root-owned under `/opt/<service-user>/libexec` before invoking the new wrapper. Every deployment coding profile and enabled explicit native quota source needs `configDir: null` for native defaults or a string for explicit storage; omission is invalid. Inventory all profiles. Preserve existing strings during this migration; changing the directory-selection mode requires separate operator confirmation. Run the rendered `update-assistant.md` sequence before restarting. For Pi, retain the approved writable `auth.json` and adjacent-lock exception, and regenerate the protected launcher after npm-prefix hardening is restored. The deployment and harness profile migrations are separate integrations; do not install a profile-aware CLI over unconverted templates.

## Review AlignDev Native-Directory Selection

`configDir` has three states for coding profiles and enabled Claude or Codex quota sources: omitted, null and string. The section "Native-directory selection" of `{{CMD}} setup guide coding-agent-assistant` defines them. Omission also applies to default quota sources such as `{ "source": "claude" }`.

Explicit quota starts from the original caller environment and applies only its own settings; coding and explicit-quota resets are independent. Omitted quota for Claude or Codex uses the finalized coding environment. Pi requires an explicit quota source or `none`; disabled quota accepts no other fields, including `configDir: null`.

Preserve existing string selections during unrelated migrations, including the examples below. Before changing one, ask the user or operator to confirm whether it should remain explicit, inherit (ordinary CLI only), or force native defaults through null. Changing modes does not promise to preserve the existing login. No settings rewrite, Keychain migration, credential transfer or automatic login is part of this feature. Authentication must reproduce the selected effective environment and cwd, including API-key routing.

For an OpenClaw deployment, every coding profile and enabled explicit quota source requires null or a string; generated defaults use null. Upgrade the CLI, the inventory and policy helpers, the settings and the matching native-command runbooks together through controlled maintenance. Inventory `configDir` output remains an absolute filesystem path for seed, policy, maintenance and backup. Native commands read the mode from the named profile or quota settings, then unset the native variable for null or set its resolved value for a string, after login-shell initialization. A shared filesystem path does not establish the invocation mode.

When re-rendering Pi, replace `PI_CONFIG_DIR` with `PI_CONFIG_DIR_JSON` (raw JSON null or an encoded string) and `PI_CONFIG_DIR_DISPLAY` (human-facing text). Substitute `PI_QUOTA_JSON` as a raw JSON object, with a null or string `configDir` for an enabled source, or only `{ "source": "none" }`. Do not put quotes around raw JSON placeholders.

## Convert AlignDev Profile Defaults

When `aligndev.settings.json` contains `code.defaultProfiles`, convert it manually to preserve the needed preferences. Any presence, including an empty or null map or a map alongside new flags, is ignored with a warning on stderr. The map never supplies defaults. Unknown keys at each fixed settings, profile and quota shape are also ignored with warnings; recognized invalid values and duplicate true flags still fail. Profile, environment and alias dictionaries remain maps. Neither the CLI nor the deployment inventory rewrites settings.

1. For each old entry, set `default: true` on its referenced profile of that harness when a preference is needed. Omit the flag when that harness has only one profile. False and omitted have the same meaning.
2. Leave at most one true flag per harness. Different harnesses may each have a preference. A flag only breaks a tie between candidates for the assistant's profile.
3. Remove `code.defaultProfiles`. Keep profile names unchanged so project references and named resumes remain valid.
4. Validate with `aligndev guide code --profile <name>` for every profile. Obtain approval before editing real settings or native account state; the CLI never rewrites them.

Before:

```json
{
  "code": {
    "defaultProfiles": { "claude": "work", "pi": "solo" },
    "profiles": {
      "work": { "harness": "claude", "configDir": "~/.claude-work" },
      "personal": { "harness": "claude", "configDir": "~/.claude" },
      "solo": { "harness": "pi", "configDir": "~/.pi/agent" }
    }
  }
}
```

After:

```json
{
  "code": {
    "profiles": {
      "work": { "harness": "claude", "default": true, "configDir": "~/.claude-work" },
      "personal": { "harness": "claude", "configDir": "~/.claude" },
      "solo": { "harness": "pi", "configDir": "~/.pi/agent" }
    }
  }
}
```

For new sessions, help, guide and quota, the assistant's profile is the sole profile matching the session, or the true flag among several matches. Without a match, the built-ins of the assistant's harness apply; another harness's profile never overrides them. An OpenClaw or unrecognized harness uses `code.fallbackProfile` instead. Flags never choose between harnesses.

Automatic profile matching is an intentional behavior change. New runs that previously used built-ins may now use configured native storage, models, environment and permission settings. Review those settings before launching.

Historical null or missing-profile resumes are separate: without an explicit or project replacement, they use only the built-ins of the assistant's harness, ignoring configured profiles and flags. The new record keeps null and the original transcript remains unchanged. Named resumes keep their recorded name ahead of the assistant's profile and flags; a deleted recorded name requires an explicit or project replacement.

On an OpenClaw host, update the private admin repository and the deployed settings through controlled maintenance, preserving the writable service AlignFirst home (see "Keep the Service AlignFirst Home Writable"). The `openclaw` profile's `defaultAgentProfile` names the coding profile, as "Convert AlignDev Harness Settings" describes. Preserve all native-store isolation and Pi authentication exceptions; upgrade the inventory helper and retain seed validation of every profile.

## Convert AlignDev Harness Settings

AlignDev resolves the assistant's harness at each invocation and no longer reads project markers. When `aligndev.settings.json` contains `platform`, `code.profile`, `portRange` or a profile `agent`, or when a `.alignfirst-projects.json` exists, convert once. The CLI ignores `platform`, `code.profile` and `portRange` with warnings on stderr. It still reads a profile's `agent` as `harness`, with a deprecation warning.

1. Remove `platform`. `ALIGNDEV_ASSISTANT_HARNESS` forces the assistant's harness for one invocation.
2. Replace `code.profile`. When a profile describes the assistant, set its `defaultAgentProfile` to the former value. On an OpenClaw account, add an `openclaw` profile whose `defaultAgentProfile` names the coding profile. For sessions without a recognized harness, set `code.fallbackProfile`.
3. Rename `agent` to `harness` in every profile, then run `aligndev guide code --profile <name>` for each coding profile.
4. Move the marker's range, or the settings' `portRange`, to the deployment's own instructions, and remove `portRange` from the settings. The assistant passes that range to `aligndev project free-ports --within <first>..<last>`. Check with `aligndev project ports` that every project's range fits in it. Delete each `.alignfirst-projects.json`, then run `aligndev project doctor`. Policy text that a marker description carried, such as allowed directories or approvals, moves to the deployment's own instructions.

Before:

```json
{
  "platform": "openclaw",
  "projectsRoot": "~/projects",
  "code": {
    "profile": "service-pi",
    "profiles": { "service-pi": { "agent": "pi", "configDir": null } }
  }
}
```

After:

```json
{
  "projectsRoot": "~/projects",
  "code": {
    "profiles": {
      "openclaw": { "harness": "openclaw", "defaultAgentProfile": "service-pi" },
      "service-pi": { "harness": "pi", "configDir": null }
    }
  }
}
```

On an AlignDev OpenClaw host, port the settings and project changes of the current `aligndev-openclaw-setup` template to the admin repository, then re-seed through controlled maintenance, preserving the writable service AlignFirst home (see "Keep the Service AlignFirst Home Writable").

## Declare AlignDev Pi Models

A `pi` profile accepts only the model names it declares: without a declaration, it rejects `--model` and `defaultModel`. A host that runs `npx -y aligndev` without a version pin picks up the release at once. Convert the settings with the upgrade, or before it through step 3 alone: earlier versions know neither `modelFamilies` nor `{latest}`. A profile that uses neither `defaultModel` nor `--model` runs Pi's own default and needs no change.

For each `pi` profile of `aligndev.settings.json`, collect its `defaultModel` and the `--model` values that scripts and instructions pass, then declare each model:

1. A model whose id follows the pattern of its `gpt`, `claude` or `gemini` family, given under `modelFamilies` in the `aligndev` README: map the family to its Pi provider in `modelFamilies`. The entry declares the aliases of the family, such as `astra`, `sol`, `terra` and `luna` for `gpt`, and each alias selects the newest version of its model.
2. Another model: add a `modelAliases` entry that targets `provider/model`, with `{latest}` in place of the version to follow the newest one. Write an id without a version number in full.
3. A full id selected as is: list it in `models`. A nonempty `models` replaces the accepted names, so it lists every name the profile accepts.

A `modelAliases` entry that pins a full id only to avoid a wrong variant can become a family or a `{latest}` target: neither matches a variant with a further suffix.

Then run `aligndev guide code --profile <name>` for each enabled `pi` profile.

A session keeps the model name it recorded. After a `defaultModel` changes from a full id to an alias, resume such a session with `--model <alias>`. A session recorded without a profile resumes on Pi's built-in profile, which declares nothing. When it recorded a model, resume it with `--profile <name>`, naming a `pi` profile that accepts that model, or add `--model` with a name the profile accepts.

Before:

```json
{
  "code": {
    "profiles": {
      "solo": { "harness": "pi", "defaultModel": "openai/gpt-6.2-sol" }
    }
  }
}
```

After:

```json
{
  "code": {
    "profiles": {
      "solo": { "harness": "pi", "defaultModel": "sol", "modelFamilies": { "gpt": "openai" } }
    }
  }
}
```

On an AlignDev OpenClaw host, add `models` beside `defaultModel` in the admin repository's `infra/openclaw/aligndev.settings.json`. The list replaces the accepted names: include the `defaultModel` and every `modelAliases` name in use. Bring `infra/openclaw/deployment-profiles.mjs` to the current `aligndev-openclaw-setup` template, then re-seed through controlled maintenance, preserving the writable service AlignFirst home (see "Keep the Service AlignFirst Home Writable").

## Rename the AlignDev Message-Tool Topics

The retired `slack-message-tool` and `discord-message-tool` guide topics are replaced by `message-tool`, read through `aligndev guide --channel <slack|discord> message-tool`. The old topics fail. On an AlignDev OpenClaw host whose workspace `AGENTS.md` still names an old topic, migrate once during `update-assistant.md`:

1. In the admin repository, bring `infra/openclaw/workspace/AGENTS.md` to the current template. On a Discord deployment, also bring `infra/openclaw/seed/surface.sh`: it sets `session.dmScope` to `per-channel-peer`, so a DM no longer shares the session of the apps' Home conversation. Commit and pull on the host.
2. Install the current stable `aligndev` through the npm packages section of `update-assistant.md`, then re-seed through the `config instructions` command in `configure-assistant.md`.

## Convert the Companion Registry

AlignFirst reads the companion registry as `{ "projects": … }`, and each entry names its companion directory. When `~/.alignfirst/companions/registry.json` has a top-level `paths`, every command fails with an error pointing here. Convert it once:

1. Rename `paths` to `projects`. The keys stay.
2. Give each entry a `dir`: the companion's current directory name under `~/.alignfirst/companions/`, so the companion stays put. The old versions derived that name from the real path of the project's main worktree: relative to the home directory, or the absolute path without its leading `/` outside it, with every `/` replaced by `_`.
3. Move the entry's item settings into `items`. `true` becomes `"companion"`, `false` becomes `"project"`, and `"auto"` is dropped. `_aligndev: true` becomes `"companion"`, and `_aligndev: false` is dropped. Omit an empty `items`.
4. Run `{{CMD}} doctor` in a project that has a companion.

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

An older `alignfirst` fails on the new shape. Update every copy that reads the registry, such as an `npx` cache or another project's local dependency.

On an AlignDev OpenClaw host, the registry stays service-owned. Convert it as the service account, after `update-assistant.md` installs the current stable `alignfirst`.

## Historical: Rename the Work-Files Folder Setting

`{{CMD}} setup guide upgrade-workspaces` supersedes this old-file transition on the current CLI; `plans.folder` is now rejected.

When a legacy `.alignfirst.json` contains `plans.folder`, preserve its value as `plans.repositoryFolder` during the clean-break conversion. Update every CLI copy that reads the configuration before using the converted file. On an AlignDev OpenClaw host, convert the admin repository's file and re-seed.

## Historical: Move Workspace Ports to the Dev-Server

This describes legacy wrapper fields before the manifest conversion. Do not execute it on the current CLI; use `{{CMD}} setup guide upgrade-workspaces`.

Ports and infrastructure belong to the dev-server's first `dev setup`. Migrate a project once when its `workspace.mjs` declares `ports` or `setupProfiles`, or when its `finalizeWorkspace` provisions infrastructure. The old wrapper assets are retired. `{{CMD}} setup guide workspace` documents the current recipe and project-owned commands.

1. Move `ports` to `dev-server.mjs` as a range. `first` is the old `base`, and `last` the old range end, `base + maxWorkspaces × perWorkspace − 1`, so `portRange` in `.alignfirst.json` stays valid. `perWorkspace` defaulted to the number of names. Rename `names` to `declare`; a `compute` function becomes the names it returned.
2. Move the files that carry ports from `gitignoredFiles` to `runFiles` in `dev-server.mjs`. Their `patch` receives `ports` as before.
3. Move the infrastructure from `finalizeWorkspace` to the dev-server's `setup`, and keep it idempotent: `dev setup --force` runs it again. Name every resource after the workspace. `finalizeWorkspace` keeps install and build, and returns nothing.
4. Remove `setupProfiles`, the profile checks in `preSetup`, and every `--profile remote` command. The run-file patches build the public URLs from `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST`, as "Public URLs" in `{{CMD}} setup guide workspace` describes. A deployment that used the public-IP profile sets `REMOTE_DEV_HOST`.
5. Give each spawn server the name of its port, such as `port: "frontend"`.
6. Offer to pin the main worktree's current ports, read from its run files, to keep them: each becomes the `mainWorktree` of its `declare` entry, as `{ name, mainWorktree }`. Linked workspaces get new ports at their next start. Their infrastructure, already provisioned, follows a moved port only when a callback `start` recreates it, as `docker compose up -d` does; otherwise run `dev setup --force` in the workspace.
7. Make `purgeInfrastructure` tear down by the workspace name, as "Teardown by name" in `{{CMD}} setup guide workspace` describes. Keep reading `purgeData` while existing workspaces carry one: the old `finalizeWorkspace` returned it, and their entries still pass it.
8. In the workspaces section of `AGENTS.md` and `ASSISTANTS.md`, say that ports and infrastructure arrive with the first `dev` or `dev setup`. See "Project documentation" in `{{CMD}} setup guide workspace`.

On an AlignDev OpenClaw host with the dev-server gateway, `REMOTE_DEV_DOMAIN` already comes from `environment.d/common.conf`. A project needs no remote setup step anymore.

## Historical: Declare Workspace Ports

When a legacy `dev-server.mjs` contains `ports.names` or a `ports.mainWorktree` map, convert its `ports` group during the clean-break migration:

1. Rename `names` to `declare`.
2. Turn each pin of `mainWorktree` into an entry `{ name, mainWorktree }` in `declare`, then remove the `mainWorktree` map.
3. Optionally, give an entry a `range` when something outside the repository enumerates its port for every workspace, such as an OAuth callback URL in a provider's allowlist. See "Port range" in `{{CMD}} setup guide workspace`.

```js
// Before
ports: { first: 8100, last: 8199, names: ["server", "frontend"], mainWorktree: { frontend: 8100 } },
// After
ports: { first: 8100, last: 8199, declare: ["server", { name: "frontend", mainWorktree: 8100 }] },
```

## Historical: Declare the Run-File Inputs

Run-file rewrites at startup depend on changed ports or declared inputs. An explicit `dev setup` still rewrites them all. Migrate once when a run-file patch or `content` function reads a value besides `ports`, such as `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST`. Return those values from `runFilesInputs` in `dev-server.mjs`, as the former wrapper asset did. Without it, a start keeps the values of the last write.

## Update the Docmap Snippet

When an `AGENTS.md` or `CLAUDE.md` has a `Docmap - Seek Documentation` section whose body says "Mandatory for every task", replace that body with the agent-instructions snippet of `{{CMD}} setup guide docmap`. Keep the heading and the project's docmap command.

## Rename the Assistant Guide

The assistant guide is `ASSISTANTS.md`. The configuration properties `assistantInstructionsFile` and `developerInstructions` are deprecated: they still name a guide under another name, and every command warns about them on stderr. The `Legacy` item of the `{{CMD}} setup` report lists them. Migrate once:

1. Create `ASSISTANTS.md` from the file that `locations.assistantInstructionsFile` reports, at the root of the same project or companion directory:
   - When the file serves only as the assistant guide, move it. When its folder changes, fix its relative links.
   - When the file has another purpose, such as `README.md`, keep it. Write a short `ASSISTANTS.md` with what only the assistant needs, as "The Assistant Guide" in `{{CMD}} setup guide assistant-project` describes, and link to the file for the rest.
2. Title `ASSISTANTS.md` `# Assistant Guide`.
3. Remove the property from the selected `alignfirst.json` or `.jsonc`.
4. Update the links to a moved guide.
5. Run `{{CMD}} assistant-instructions` and check that it prints the guide without a warning.
