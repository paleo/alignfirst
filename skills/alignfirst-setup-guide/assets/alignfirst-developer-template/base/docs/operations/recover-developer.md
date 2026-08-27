---
title: Recover the Developer
read_when:
  - restoring service after a failed update or incident
---

# Recover the Developer

## Contain

**Role: service user.** Resolve targets, then stop only developer-owned work:

```sh
infra/openclaw/bin/developer-kill.sh
systemctl --user status openclaw-gateway.service
```

The kill switch stops the gateway service and active `alcode` processes. It does not stop the user's
service manager or all rootless containers.

## Diagnose and Restore

1. Preserve journals, failed alcode session files, and the current broken state without secrets.
2. Select the last known-good deployment backup.
3. Restore the affected workspace, secure environment, configuration source, skill, or package only.
4. Re-authenticate interactively when the runtime or delegated agent reports expired authentication.
5. Run `seed.sh`, `openclaw config validate`, and `openclaw secrets audit` before service start.
6. Start the user service and inspect its journal.

**Role: privileged server administrator** participates only when the service account, filesystem
ownership, lingering, system packages, firewall, or host service manager is damaged.

## Verify and Reopen

Run allowlist negatives, channel/thread routing, project inventory, workspace setup, read-only
delegation, restart, and repeated-wake suppression. Reopen user access only after all affected checks
pass. Record the incident and the exact restored backup.
