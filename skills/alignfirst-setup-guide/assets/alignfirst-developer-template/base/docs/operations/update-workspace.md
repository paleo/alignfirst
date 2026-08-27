---
title: Update the OpenClaw Workspace
read_when:
  - changing bootstrap identity, audience, or dispatcher instructions
---

# Update the OpenClaw Workspace

**Role: repository support work**, then **service user** for application.

Keep `AGENTS.md` as a lean direct dispatcher. Put situational procedure changes in the playbook skill,
not the auto-loaded workspace. Preserve `NO_REPLY`, channel/thread separation, `alproject` inventory,
and deferred `alcode --openclaw-guide` loading.

```sh
infra/openclaw/bin/backup.sh
infra/openclaw/bin/apply-workspace.sh
openclaw config validate
systemctl --user restart openclaw-gateway.service
```

Review the backup path printed by the first command. Verify a channel request, fresh thread handoff,
audience classification, and one read-only delegated run. Restore the prior workspace backup and
restart when the new instructions regress routing.
