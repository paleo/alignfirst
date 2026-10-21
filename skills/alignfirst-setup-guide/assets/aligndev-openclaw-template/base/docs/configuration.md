---
title: Configuration
read_when:
  - looking for the record of the OpenClaw configuration
  - wondering which file owns a setting
  - deciding what to do when an OpenClaw release changes a default
---

# Configuration

The seed is the record of the OpenClaw configuration. No copy of `openclaw.json` is tracked: `seed.sh` derives it from the installed version's defaults and the sources below, so the repository shows the intent and the server holds the result.

## Stock defaults

The seed carries only the settings this deployment decided. Everything else stays at the installed version's default, and follows that default when a release changes it.

Pin a value only when a stated policy requires it, and record the policy in the comment beside the setting. Preserving previous behavior is not a policy.

## Sources

- `infra/openclaw/.env` — every deployment value and secret the seed reads (gitignored; `.env.example` documents each variable).
- `infra/openclaw/seed/common.sh` — the baseline: model, memory opt-outs, heartbeat, skill allowlist, tools, updates, thread sessions, identity, gateway, plugin allowlist. Also the helpers every module calls.
- `infra/openclaw/seed/surface.sh` — the channel plugin, its credentials as SecretRefs, the allowlisted channel.
- `infra/openclaw/seed/coding-agent.sh` — the delegated coding agent's global instructions (merged into its instruction file).
- `infra/openclaw/environment.d/` — non-secret variables for the gateway and login shells (`common.conf`; `runtime.conf` is generated).
- `infra/openclaw/aligndev.settings.json` — platform, projects root, `code.profile` and complete `code.profiles` definitions. The seed installs it at `~/.alignfirst/aligndev.settings.json`. Each Claude/Codex profile's `skipPermissions` passes its native bypass flag for unattended runs; it has no effect on Pi. Its `unset` removes inherited API-key routes. Its required `configDir` pins native routing: null unsets the agent's directory variable; a string sets its resolved explicit path. A default-directory string remains distinct from null.
- `infra/openclaw/deployment-profiles.mjs` — complete coding/quota-store and managed-resource inventory. Every coding or enabled quota store needs `configDir: null` for native-default mode or an explicit directory string isolated beneath the service home. Omission is invalid in deployments. Inventory output always contains absolute filesystem paths, including for null. Native invocations retain the original profile/quota mode, even when inventory deduplicates a shared path. Shared same-agent stores are deduplicated; custom stores are supported. `~/` resolves against the service home and relative paths against deployed settings. Managed anchors/non-package resources reject symlinks and hardlinks; package links must resolve entirely within their own tree. Unsafe overlaps, padded paths, `file:` URLs, HOME/session overrides and resource escapes fail closed. The selected default agent must match the overlay; additional kinds need their own reviewed installation/instructions/authentication. This deployment policy is narrower than the CLI's general profile support.
- `infra/openclaw/deployment-policy.mjs` — preparation, scope-aware hardening/unlock and private mapped backup/recovery. Install both helpers root-owned under `/opt/{{SERVICE_USER}}/libexec/` for maintenance/backup, as well as in the seed snapshot for setup. Pi resources include context alternatives, system prompts, settings/models/MCP/keybindings, trust, extensions, skills, prompts/themes, native bin helpers, agents, package trees and declared local roots. Executable package modes are preserved. Root-owned sticky writable anchors protect against parent replacement while permitting auth locks and runtime state.
- `infra/openclaw/workspace/` — the workspace files, applied by `apply-workspace.sh`.
- `infra/openclaw/heartbeat-scratch.md` — the heartbeat job's checklist, pushed by `apply-heartbeat-scratch.sh` ([04 § 7](installations/04-openclaw.md#heartbeat-scratch)).
- `infra/openclaw/projects/.alignfirst-projects.json` — the project parent, policy, and port range used by `aligndev project`.

## Profiles, authentication and trust

AlignDev and the deployment inventory ignore unknown or obsolete keys at the settings root, `code`, each profile and each quota object, with value-free warnings on stderr. Dynamic profile, environment and alias dictionaries remain maps. Recognized invalid values, duplicate defaults and deployment safety violations still fail. Neither reader rewrites settings. Retired direct launch fields and `code.defaultProfiles` supply no behavior; convert them manually into profiles and profile-local `default` flags. Deployment still requires explicit valid `code.profile`.

Pi's provider/model, authentication method and optional quota source are collected separately from OpenClaw's conversational model. Use provider-qualified native selectors in `modelAliases`: an exact ID pins a model; shorthand delegates resolution to Pi. Quota uses its separately configured Claude/Codex account and does not prove Pi account identity.

Pi's native `<agent-dir>/auth.json` is the sole approved executable-declaration exception. It remains private, service-owned and replaceable with adjacent locks for OAuth and automatic refresh-token renewal. The file may contain executable API-key commands; another same-UID process can persist them for later account-level execution. Permissions cannot distinguish that write from renewal. All other managed declarations/resources stay protected through maintenance. Never make the entire Pi directory immutable.

Save trust manually in `<agent-dir>/trust.json` for one approved parent containing the project and future worktrees. The nearest saved decision wins. Record the boundary; do not silently trust `~/projects`, set `defaultProjectTrust: "always"` or add `--approve`. Trust is not a sandbox. The editable project registry can select every provisioned profile; install only accounts intended to be available to this Linux user.

## Module contract

`seed.sh` sources the three modules and calls, in order, `validate_common`, `validate_surface`, `validate_coding_agent`, then `configure_common`, `configure_surface`, `configure_coding_agent`. Each module declares its required variables (`required_*`) and its secret variables (`secret_variables_*`); the surface module also declares `surface_plugin_id`. Every setting goes through `openclaw config set`; every credential through `set_secret_ref`.

The seed validates every installed profile with explicit `--profile`, so a registry entry for its cwd cannot redirect validation. At runtime, project selection can override `code.profile`; provision only profiles intended to be available to this service account. Registry routing is not account authorization.

To change something: edit the owning source, then [configure-assistant.md](operations/configure-assistant.md).
