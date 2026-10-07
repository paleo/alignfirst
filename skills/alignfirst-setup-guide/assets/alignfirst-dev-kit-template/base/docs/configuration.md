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
- `infra/openclaw/aligndev.config.json` — the `aligndev` config: platform, projects root and coding agent. The seed installs it at `~/.alignfirst/aligndev.config.json`, the fixed path `aligndev` reads. `code.skipPermissions` passes the agent CLI's permission-bypass flag, since backgrounded runs have no approval loop. `code.unset` strips the listed variables from the agent's environment, so the agent uses its own login, never a stray API key.
- `infra/openclaw/companions.json` — declares the projects whose AlignFirst files may live in a companion directory, outside the repository. The seed installs it at `~/.alignfirst/companions.json`, read by `alignfirst` and `aligndev`. The template's `"~/projects": {}` covers every project, so the assistant creates a new project's companion under `~/.alignfirst/companions/` without a configuration change. Each item stays in the repository when the repository has it. The `alignfirst` package README documents the per-item flags.
- `infra/openclaw/workspace/` — the workspace files, applied by `apply-workspace.sh`.
- `infra/openclaw/heartbeat-scratch.md` — the heartbeat job's checklist, pushed by `apply-heartbeat-scratch.sh` ([04 § 7](installations/04-openclaw.md#heartbeat-scratch)).
- `infra/openclaw/projects/.alignfirst-projects.json` — the project parent, policy, and port range used by `aligndev project`.

## Module contract

`seed.sh` sources the three modules and calls, in order, `validate_common`, `validate_surface`, `validate_coding_agent`, then `configure_common`, `configure_surface`, `configure_coding_agent`. Each module declares its required variables (`required_*`) and its secret variables (`secret_variables_*`); the surface module also declares `surface_plugin_id`. Every setting goes through `openclaw config set`; every credential through `set_secret_ref`.

To change something: edit the owning source, then [configure-assistant.md](operations/configure-assistant.md).
