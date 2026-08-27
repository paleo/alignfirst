---
title: Configuration
read_when:
  - changing runtime, project, channel, or delegated-agent settings
---

# Configuration

Version-controlled source under `infra/openclaw/` defines intent. The installed OpenClaw CLI derives
effective configuration from its own version's baseline. No tracked `openclaw.json` is authoritative.

## Sources

- `secrets/environment` — untracked owner-only values and non-secret deployment environment.
- `seed/common.sh` — surface-independent runtime settings.
- `seed/surface.sh` — selected channel settings and SecretRefs.
- `seed/coding-agent.sh` — selected delegated-agent selector and global instructions.
- `workspace/` — reviewed bootstrap source applied to the live workspace.
- `alproject/` — immutable project-parent configuration and custom guide.

Each overlay implements `validate_*` and `configure_*`. `seed.sh` loads and validates all three modules
before configuration changes, then runs `openclaw config validate` and `openclaw secrets audit`.

## Change Procedure

**Role: repository support work**, then **service user** for deployment.

1. Update one owning source file in a workspace.
2. Run JSON, shell, docmap, and repository validation.
3. Review the diff and commit it.
4. Create a deployment backup.
5. Unprotect only the affected live paths.
6. Run `infra/openclaw/seed.sh` and, for workspace changes,
   `infra/openclaw/bin/apply-workspace.sh`.
7. Validate before `systemctl --user restart openclaw-gateway.service`.
8. Restore protection and run the focused smoke test.

Runtime provider/model, channel, and delegated agent remain independent selections.
