# A Coding Agent as the Assistant

Claude Code, Codex or a persistent Pi session can act as the AlignFirst assistant on one project: the repository where its session starts. It follows the `aligndev` playbook and delegates through `aligndev code`. Parent host and selected child are independent; no OpenClaw deployment is needed.

Supported systems: Linux and macOS, and Windows through WSL.

## 1. Prepare the project

The project needs usable effective work files, untracked by its own repository or in its companion directory. A separate work-files repository may track them. Missing or project-tracked effective plans follow `aligndev guide work-files-setup` before ticket or session effects; companion selection requires authorization and preserves old project content without copying it. Follow [AlignFirst setup](alignfirst-skills-setup.md#configure-the-project), with [plans-setup.md](plans-setup.md) for a work-files repository, or [companion-setup.md](companion-setup.md) for a repository that must stay untouched.

[Prepare a Project for an Assistant](../SKILL.md#prepare-a-project-for-an-assistant) applies: skip command skills and global bootstrap changes. All stacks use `alignfirst workspace`; a manifest is optional. Prepare effective plans and ignored, untracked `.local-wt/` first. Default readiness is protocol-ready, with install/build/test commands delegated separately. A fresh harness worktree can be adopted in place through `alignfirst workspace setup` after the playbook selects its branch. External owners retain deletion; run teardown before their deletion and preserve Paseo archive-before-removal. Choose a developer guide, commonly `DEVELOPERS.md` or `README.md`, and record its relative path explicitly as `developerInstructions` in the selected `alignfirst.json` or `.jsonc`. Run `alignfirst developer-instructions` from the selected worktree; it prints conventions and configured content with its absolute source path. Without a reference, it prints conventions only. Missing configured content is an error. Use nullable `locations.developerInstructions` in `alignfirst config --json` to find the editing destination, including companion placement. Keep this human/assistant guide distinct from coding-agent `AGENTS.md` or companion context; do not copy entire documents between them. Retired wrappers/settings/state require [the clean-break runbook](../../../docs/upgrading-multi-stack-workspaces.md).

## 2. Configure `aligndev` (recommended)

Without settings, one detected parent kind supplies built-in child defaults. For a minimal singleton setup, write `~/.alignfirst/aligndev.settings.json`:

```json
{
  "code": {
    "profiles": { "claude-personal": { "agent": "claude" } }
  }
}
```

A profile's required `agent` selects the child: `claude`, `codex` or `pi`, independently of the parent's launch tool. Profiles are complete, without inheritance. The example selects `claude-personal` for a Claude parent or with no detected parent. Another detected kind keeps its own built-ins when no profile matches. With several profiles matching one detected kind, set one matching profile's `default: true` or make a named choice. Omitted and false flags are equivalent; at most one true flag per agent is allowed. A flag never chooses between agent kinds. No parent with several profiles, or several detected kinds, requires a named choice.

New-session, help, `guide code` and quota selection is `--profile` → actual-cwd project registry selection → global `code.profile` → automatic resolution. Named choices bypass detection; `code.profile` can deliberately choose a different child kind. Resume inserts its latest recorded named profile before the global selection. A deleted recorded name requires explicit/project replacement. Historical null/missing profiles use detected built-ins unless explicit/project/global selection replaces them; counts and flags never trigger inference there. The original transcript stays unchanged. Help/guide/quota share the resolver outside Git and `.plans`. Status reads durable metadata without validating launch settings. Unknown or obsolete settings keys are ignored with value-free warnings on stderr; recognized invalid values and duplicate defaults still fail. The CLI never rewrites settings or applies retired launch/default-map semantics. For existing settings, follow the [launch-settings](alignfirst-upgrade.md#convert-aligndev-launch-settings) and [profile-default](alignfirst-upgrade.md#convert-aligndev-profile-defaults) migrations.

`configDir` selects native storage through `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `PI_CODING_AGENT_DIR`:

- **Omitted:** inherit the caller's variable unless profile `env` or `unset` changes it; without a variable, native defaults apply. Use omission for ordinary Claude, Codex and Pi setup. Do not add a directory-selection question unless the user asks to select a specific native configuration.
- **Null:** deliberately remove the variable to force native-default directory behavior despite an inherited override. For example, `"configDir": null` resets directory routing only; HOME, PATH and API-key precedence remain unchanged.
- **String:** resolve and set the variable for an intentional selection, such as `"~/.claude-work"`. Strings naming default paths remain explicit selections. `~/` uses the configured home; relative paths use the settings directory.

On macOS, explicitly setting `CLAUDE_CONFIG_DIR` to the default path can select different Keychain credentials from leaving it unset. Confirm the user's intended mode before changing an existing string; AlignDev performs no settings rewrite, automatic login or credential transfer.

Profiles can supply literal non-secret `env` values and remove inherited variables with `unset`. No shell expansion occurs; credentials remain in native stores or provisioned process environments. A variable cannot appear in both fields. A string or null `configDir` conflicts with its matching native variable in either field. Before login, reproduce the child's effective environment and cwd: apply `unset/env/configDir`, including HOME, PATH and credential routing. Help and guides identify storage-variable origins without printing their values; a bare login in another shell may select another account.

For Pi, prefer provider-qualified `modelAliases` targets. Exact IDs pin a model; fuzzy native selectors and thinking suffixes pass unchanged to Pi. For example, separate `pi-codex` and `pi-anthropic` profiles can map `sol` to `openai/sol` and `opus` to `anthropic/opus`, using separately provisioned native configurations. AlignDev never infers their providers or account identity. Targets are illustrative and depend on the native catalog. One alias expands after validating the chosen name, without recursion. Without a nonempty profile `models`, Pi accepts any nonblank selector; Claude/Codex accept their built-in names plus configured aliases. A nonempty list replaces accepted names. New sessions use profile `defaultModel`, else the native default.

Resume retains and validates its recorded user-facing model, ignoring profile defaults. Disallowed names require `--model`; null keeps the native conversation model. Current alias mappings apply even to retained names. The selected native account must contain the original conversation; cross-agent resumes fail, and Pi requires the recorded real directory. No fallback account or replacement conversation is accepted. The [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#configuration) documents every profile field and independent quota settings. Omitted quota uses a native Claude/Codex profile's effective environment. For Pi, follow [Optional quota setup for Pi](#optional-quota-setup-for-pi). Quota selection follows new-session precedence, needs no ticket or `.plans`, and never changes the coding child.

Check whether the developer's shell exports `ANTHROPIC_API_KEY` (Claude Code) or `CODEX_API_KEY` (Codex); check the names only, never print the values. The agent runs non-interactively (`claude -p`, `codex exec`), where such a key overrides the subscription login, even when the developer's own session declined it. When the developer wants the agent on their subscription, list the key in the profile's `unset`:

```json
{
  "code": {
    "profile": "claude-personal",
    "profiles": {
      "claude-personal": {
        "agent": "claude", "unset": ["ANTHROPIC_API_KEY"]
      }
    }
  }
}
```

For a Pi child, start `pi` under the account/configuration the child will use and run `/login <provider>`, or configure the provider's credentials. Pi uses its native credential precedence; do not assume the Claude/Codex environment-key rules above apply. Inspect only credential-variable names, never values. Saved project trust must cover the execution directory and required project resources; do not force `--approve` to bypass missing trust.

### Optional quota setup for Pi

Codex CLI is not required to run Pi, including Pi's ChatGPT subscription route. It is an optional quota helper when `quota.source` is `codex`. The `claude` source analogously requires Claude Code; `none` requires neither CLI. Pi without an explicit quota source has no supported quota reader.

1. **Choose the source deliberately:** `codex`, `claude` or `none`. Never infer the provider or account from a model alias. Native quota reports describe the selected CLI's account limits. Codex's ChatGPT limits and Claude's subscription limits do not measure arbitrary provider/API-key billing, Anthropic Console usage or another provider's allowance. Use `none` when no native account quota is relevant.
2. **Install the chosen CLI if absent** from the quota environment's PATH. Obtain approval before global installation. Reuse the existing [Codex installer guidance](../assets/aligndev-openclaw-template/variants/coding-agents/codex/docs/installations/08-coding-agent.md#admin-account) or [Claude Code installer guidance](../assets/aligndev-openclaw-template/variants/coding-agents/claude-code/docs/installations/08-coding-agent.md#admin-account). Use only the installer from those deployment runbooks, not their aliases, settings or hardening steps.
3. **Configure quota in the Pi profile** in `~/.alignfirst/aligndev.settings.json`. For example:

   ```json
   {
     "code": {
       "profile": "pi-quota",
       "profiles": {
         "pi-quota": {
           "agent": "pi",
           "quota": {
             "source": "codex",
             "configDir": "~/.codex-pi-quota",
             "unset": ["CODEX_API_KEY", "OPENAI_API_KEY"]
           }
         }
       }
     }
   }
   ```

   Explicit quota starts from the original caller environment, applies only quota's own `unset`, `env` and source-specific `configDir`, then strips parent-session identities. Pi profile overrides are not copied. The same path and validation rules described above apply. Choose `quota.configDir` only when needed. Omission inherits the quota source's variable independently from the original caller; quota `env` or `unset` may change it. Null deliberately removes `CODEX_HOME` for Codex or `CLAUDE_CONFIG_DIR` for Claude. A string sets explicit storage, as in this custom-account example. Coding and explicit-quota directory resets do not affect each other; neither selects Pi's store. For an ordinary Claude quota source, `{ "source": "claude" }` needs no directory field.

   For Claude subscription quota, replace the quota object with `{ "source": "claude", "configDir": "~/.claude-pi-quota", "unset": ["ANTHROPIC_API_KEY"] }`. To disable quota, use only `{ "source": "none" }`, without other quota fields, including `configDir: null`.
4. **Authenticate the native CLI separately.** The human completes login under the same OS user, cwd and effective environment/configuration directory as the quota query. Reproduce quota's `unset/env/configDir`, including HOME, PATH and any credential routing. Pi's `auth.json` and `/login` credentials are not automatically imported into Codex or Claude Code. Never copy tokens between their stores.

   For the Codex example above, with ordinary HOME/PATH and no additional credential routing:

   ```sh
   mkdir -p "$HOME/.codex-pi-quota"
   env -u CODEX_API_KEY -u OPENAI_API_KEY CODEX_HOME="$HOME/.codex-pi-quota" codex login
   ```

   For the Claude subscription alternative:

   ```sh
   mkdir -p "$HOME/.claude-pi-quota"
   env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$HOME/.claude-pi-quota" claude auth login --claudeai
   ```

   Adapt these commands to the actual quota environment; a bare login in another shell may authenticate another store or route. Inspect credential-variable names only. Keep secrets out of chat, settings examples, shell history and logs; complete browser/device authentication privately.
5. **Confirm the intended account pairing.** When quota should represent Pi's allowance, compare the identity and organization/workspace selected during the native login with those used for Pi's relevant provider login. A shared email alone may not establish the same allowance. For existing logins, use the provider's account UI or native identity information where available; do not dump credential files. AlignDev does not automatically verify account identity. Successful login or quota retrieval alone does not prove a match.

   Once separately authenticated, `aligndev code quota --profile pi-quota` reads the selected native account's limits. The report labels the profile/source, not a verified Pi account. If pairing cannot be established, treat it only as that CLI's quota or select `none`.

For an OpenClaw Pi deployment, installation and native authentication target the service account and its effective service environment, not the operator's login. Follow the [Pi deployment overlay](../assets/aligndev-openclaw-template/variants/coding-agents/pi/docs/installations/08-coding-agent.md), including protected native stores, the absolute-Node launcher and the explicit writable `auth.json` exception. This optional quota procedure alone does not establish deployment readiness.

## 3. Install the skill globally

The `aligndev` skill goes in the developer's global agent configuration:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes --skill aligndev </dev/null
```

Add `--agent claude-code`, `--agent codex` or `--agent pi` to target one host. The verified `skills@1.7.2` Pi target installs globally under `~/.agents/skills/`, which Pi discovers. Check the installer's current help/source when upgrading rather than assuming its layout. Restart the agent after installation.

Without a skill, add the "Aligndev" section from the [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#without-a-skill) to the developer's global agent instructions instead. The user then asks the session to work with aligndev.

## 4. Install Pi tools for the requested roles

The skill supplies instructions only. Neither extension installs it, the CLI, profiles or the other extension. Obtain approval before global installation:

- **Pi parent assistant:** `pi install npm:@alignfirst/pi-background`. This generic tool runs the ordinary quoted `aligndev code` command; the playbook supplies `--quiet`, unique run identity, result retrieval and workflow decisions.
- **Pi coding child:** `pi install npm:@alignfirst/pi-subagent` in that child's environment for isolated plan/review assignments. The assistant still delegates through `aligndev code`, never directly through `subagent`.

Install both when both roles use Pi. Before installing the packaged subagent replacement, identify any existing extension registering `subagent` and obtain explicit approval to disable it through `pi config`. Do not overwrite the local extension or profiles, or load both implementations. Reload after installation; `/reload` cancels active jobs and subagents.

These packages target Pi 1.3.0 and require Node.js 22.19 or later. A Pi assistant must remain alive after acknowledging a launch; print/JSON one-shot processes do not qualify. Missing `background` capability is a setup blocker, not permission to block on bash or detach with `&`. Manual compaction or cancelled navigation can delay notices; interruption/queue clearing can lose automatic continuation. Submitted notices can survive navigation/reload, so validate current handle ownership before acting. Delivery is not exactly once, and shutdown cancels work without crash recovery. See [Pi Extensions](https://github.com/paleo/alignfirst/blob/main/docs/pi-extensions.md) and the linked package READMEs for contracts.

## 5. Start the assistant

Start the host in the project's repository and invoke `/aligndev` in Claude Code, `$aligndev` in Codex, or `/skill:aligndev` in Pi. The skill runs `npx -y aligndev guide`; no global AlignDev CLI installation is required. Confirm skill discovery and the requested tools without changing trust/settings merely to test them.

## Permissions

Claude Code/Codex parents use their established elevation: request escalated permissions in Codex, or disable Claude Code's sandbox for the launch when enabled. The developer approves those requests because the child needs network and writes outside the project.

Pi and both extensions use ordinary OS permissions. The cwd controls discovery, not filesystem isolation. Saved project trust controls resource loading, not tool access; A profile's `skipPermissions` has no effect on Pi. The CLI prepares companions and injects project context; the generic tool only honors command and cwd.
