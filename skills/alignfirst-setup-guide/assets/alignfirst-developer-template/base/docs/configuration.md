---
title: Configuration
read_when:
  - looking for the record of the OpenClaw configuration
  - wondering which file owns a setting
---

# Configuration

The seed is the record of the OpenClaw configuration. No copy of `openclaw.json` is tracked: `seed.sh` derives it from the installed version's defaults and the sources below, so the repository shows the intent and the server holds the result.

## Sources

- `infra/openclaw/.env` — every deployment value and secret the seed reads (gitignored; `.env.example` documents each variable).
- `infra/openclaw/seed/common.sh` — the baseline: model, memory opt-outs, heartbeat, skill allowlist, tools, updates, thread sessions, identity, gateway, plugin allowlist. Also the helpers every module calls.
- `infra/openclaw/seed/surface.sh` — the channel plugin, its credentials as SecretRefs, the allowlisted channel.
- `infra/openclaw/seed/coding-agent.sh` — the delegated coding agent's global instructions (merged into its instruction file).
- `infra/openclaw/environment.d/` — non-secret variables for the gateway and login shells (`common.conf`, `coding-agent.conf`; `runtime.conf` is generated).
- `infra/openclaw/workspace/` — the workspace files, applied by `apply-workspace.sh`.
- `infra/openclaw/heartbeat-scratch.md` — the heartbeat job's checklist, pushed by `apply-heartbeat-scratch.sh` ([04 § 7](installations/04-openclaw.md#heartbeat-scratch)).
- `infra/openclaw/alproject/` — `.alproject.json` (project parent, port range) and the guide appended to `alproject --guide`.

## Module contract

`seed.sh` sources the three modules and calls, in order, `validate_common`, `validate_surface`, `validate_coding_agent`, then `configure_common`, `configure_surface`, `configure_coding_agent`. Each module declares its required variables (`required_*`) and its secret variables (`secret_variables_*`); the surface module also declares `surface_plugin_id`. Every setting goes through `openclaw config set`; every credential through `set_secret_ref`.

To change something: edit the owning source, then [configure-developer.md](operations/configure-developer.md).
