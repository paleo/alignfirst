---
title: Troubleshooting
read_when:
  - diagnosing a failed gateway, delegation, or project route
---

# Troubleshooting

**Role: service user** for read-only diagnostics. Use the `sysadmin` workflow before changing
infrastructure. Keep secrets out of copied logs and reports.

## Gateway

```sh
systemctl --user status openclaw-gateway.service
journalctl --user -u openclaw-gateway.service --since today
openclaw config validate
openclaw secrets audit
```

Check the first failing event, not the final restart symptom. Confirm the service environment path and
workspace path before editing anything.

## Project Routing

```sh
alproject list --json
alproject status '<canonical-main-worktree>' --json
```

An unregistered filesystem project requires preparation and registration. A registered missing path
requires restoring the clone or a deliberate unregister. Never edit the registry directly.

## Delegation

```sh
alcode --guide
alcode --openclaw-guide
```

Read the referenced `.plans/**/_alcode/*.md` session file. `exitReason: auth_required` means the human
must authenticate the selected coding-agent CLI before retrying. Preserve failed session files.

## Channel and Thread Flow

Use the selected channel runbook's smoke test. Check the allowlist, session binding, starter
history, and destination before changing playbook text. The selected surface runbook owns its
history-recovery and thread-delivery contract.

## Incident Notes

Record deployment-specific incidents in this generated repository after removing sensitive values.
Keep version-specific workarounds out of the reusable template.
