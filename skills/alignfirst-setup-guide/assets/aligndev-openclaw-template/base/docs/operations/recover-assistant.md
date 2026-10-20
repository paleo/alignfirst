---
title: Recover the Assistant
read_when:
  - the assistant misbehaves and must be stopped
  - restoring the service after a failed update or a broken configuration
---

# Recover the Assistant

**Operator.** Contain first, then diagnose, restore, re-authenticate when needed, re-seed, verify. Record the incident in `.reports/`.

## Contain

The kill switch stops the gateway and every rootless container, terminates all account workloads, and fails if anything except the user manager and `(sd-pam)` survives:

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
ps -u {{SERVICE_USER}}
```

## Diagnose

```sh
sudo -i -u {{SERVICE_USER}} -- journalctl --user -u openclaw-gateway --since "-2h" --no-pager | tail -200
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
sudo -i -u {{SERVICE_USER}} -- openclaw config validate
```

A delegated run leaves its session file under the project's `.plans/<ticket>/_aligndev/`; read it before restoring anything. `exitReason: auth_required` means the coding agent's login expired — [08-coding-agent.md § Authenticate](../installations/08-coding-agent.md#authenticate). A provider error means the runtime login — [04 § 10](../installations/04-openclaw.md#10-provider-login). Keep the failed files.

## Restore

With the account contained, refresh the protected helper pair and seed snapshot as described in [update-assistant.md](update-assistant.md#maintenance-controls). `backup.sh` copies deployment state and all inventoried native stores; run it now as well, so the broken state is kept. If missing declared npm contents prevent backup validation, preserve the damaged state separately in private staging while contained, then use `native-recovery` with an existing reviewed backup. Keep backups private (directories `0700`, files `0600`), never in reports or version control:

```sh
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh
sudo -i -u {{SERVICE_USER}} -- ls /home/{{SERVICE_USER}}/backups/deployment/
# Select a reviewed backup below; <stamp> is its directory name.
```

A backup at `~/backups/deployment/<stamp>/` contains plain deployment files, an OpenClaw archive, and a mapped `native/` subtree. Restore locked files through the listed maintenance scope:

| Backup file | Live path | Maintenance scope |
| --- | --- | --- |
| `openclaw.json` | `~/.openclaw/openclaw.json` | `config` |
| `secrets.json` | `~/.openclaw/secrets/secrets.json` | — |
| `openclaw.env` | `~/.openclaw/.env` | — |
| `workspace/*.md` | `~/.openclaw/workspace/` | `workspace` |
| `environment.d/*.conf` | `~/.config/environment.d/` | — |
| `aligndev.settings.json` | `~/.alignfirst/aligndev.settings.json` | `config` |
| `companions/` (with `registry.json`) | `~/.alignfirst/companions/` | — |
| `thread-handoff/state.sqlite*` | `~/.openclaw/thread-handoff/` | — |
| `native/store-*` and `native/resource-*` | Original native/custom stores and declared external resources from `native/mapping.json` | `native-recovery` |

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- install -m 600 \
  /home/{{SERVICE_USER}}/backups/deployment/<stamp>/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/openclaw.json
```

### Native stores and resources

`native/mapping.json` records every provisioned coding/quota store, its original destination, presence and executable paths. Shared stores are deduplicated. External managed resource roots have separate mappings. Credentials, sessions, saved trust, settings, package declarations and package trees are included; do not copy only `~/.pi/agent` when a custom directory or another profile is configured.

First make the admin repository's profile settings match the backup's intended destinations and ordering. Confirm that deployed profile settings match. When only declared npm contents are missing, run native recovery before ordinary maintenance; strict `config` maintenance also refuses that incomplete state. Review paths only, without opening credentials:

```sh
sudo -H -u {{SERVICE_USER}} jq \
  '{version, stores: [.stores[] | {agent, destination, source, present}], resources: [.resources[] | {destination, source, present}]}' \
  /home/{{SERVICE_USER}}/backups/deployment/<stamp>/native/mapping.json
# The wrapper invokes the protected deployment-policy.mjs recover helper.
sudo /usr/local/sbin/alignfirst-assistant-maintenance native-recovery -- \
  /home/{{SERVICE_USER}}/backups/deployment/<stamp>/native
```

Recovery is destructive: it replaces each mapped store/resource's contents, including credentials, sessions and trust, and removes post-backup files. A store absent at backup time is emptied. Preserve the failed state first. The helper validates the complete mapping and source trees before deleting anything, uses backed-up native declarations to recover external resources, and restores recorded executable modes. It rejects mismatched destinations, unsafe paths, hardlinks and non-package symlinks. Only contained, relative package-tree links are accepted in a backup.

The dedicated `native-recovery` route opens all three native scopes and runs only the installed recovery helper. Root first validates the private backup against the reviewed admin profile settings and snapshots its resolved resource inventory alongside the current inventories. This includes external declarations whose live native settings were lost; raw backup destinations never authorize an unlock. The service helper receives a temporary, root-protected readable copy of the reviewed profile settings. The admin home and root-private inventory snapshots stay inaccessible to the service account.

Native recovery permits missing declared npm installations during inventory and private snapshots, so a lost package tree can be restored. Other path, link and mapping validations remain enforced. Normal maintenance stays strict; use this route only for native recovery. After restoration, current declarations must pass strict validation before cleanup can report success. Native root-owned sticky anchors stay in place; recovery replaces their contents rather than renaming the roots or merging executable state. The wrapper recontains the account and restores hardening after success or failure. A failed restore can leave partial content; keep the gateway stopped until recovery and policy restoration both succeed. Never hand ownership of an entire Pi store to the service account or run recursive `chmod 644` over packages.

### Failed maintenance cleanup

If the wrapper reports failed recontainment, gateway state is unknown. Resolve the kill-switch failure before any privileged repair. On failed cleanup it retains a private, root-owned inventory directory and prints its path. Keep it until restoration is verified; it records resolved pre-unlock resources even when live declarations were removed or corrupted. The service account must never read or edit that inventory.

After successful containment, repair the reported unsafe paths or invalid declarations from reviewed sources. A normal maintenance window validates before unlocking and may refuse damaged state. For native declarations, the operator can unlock the required scope with `unlock-snapshot` against each retained snapshot, repair that scope as the service account, then restore it with `harden-snapshot`. Use only the installed protected helper. Reapply the fixed-path policy from [06](../installations/06-security-hardening.md) for any failed non-native scopes.

Restore the original native inventories as root, then protect the current declarations too. Replace `/tmp/<retained-inventory>` with the exact directory printed by the failed wrapper:

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
sudo bash --noprofile --norc <<'EOS'
set -euo pipefail
inventory=/tmp/<retained-inventory>
home=/home/{{SERVICE_USER}}
deployed="$home/.alignfirst/aligndev.settings.json"
policy=/opt/{{SERVICE_USER}}/libexec/deployment-policy.mjs
test ! -L "$inventory"
test "$(stat -c '%u:%a' "$inventory")" = 0:700
for snapshot in "$inventory"/*.json; do
  test -f "$snapshot" && test ! -L "$snapshot"
  test "$(stat -c '%u:%a' "$snapshot")" = 0:600
  /usr/bin/node "$policy" harden-snapshot "$snapshot" "$home" "$deployed"
done
for settings in /home/{{SERVER_ADMIN_USER}}/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/aligndev.settings.json "$deployed"; do
  /usr/bin/node "$policy" harden "$settings" "$home" "$deployed"
done
EOS
```

Every command must succeed before opening another window. Repeat the real-UID checks from `06`, then run a no-op maintenance window with the failed scopes to verify the full restoration path. Remove the retained inventory as root only after these checks. Do not restart on an unresolved restoration error.

### OpenClaw state

The archive `*-openclaw-backup.tar.gz` holds OpenClaw-owned SQLite state (sessions, cron jobs and
their scratch, plugin consent, device pairing) and auth profiles. The adjacent `thread-handoff/`
files are the external plugin's independent database and any WAL/SHM crash state; restore that set
together while the gateway is stopped. See the package README before retiring claimed records.
Verify and extract into a fresh, private staging directory outside the live state:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw backup verify \
  /home/{{SERVICE_USER}}/backups/deployment/<stamp>/<archive>-openclaw-backup.tar.gz
sudo -H -u {{SERVICE_USER}} bash -lc 'umask 077; openclaw backup restore "$HOME/backups/deployment/<stamp>/<archive>-openclaw-backup.tar.gz" --target "$HOME/backups/restore-<incident>"'
```

The target must be absent or empty. Extraction retains the archive root, manifest and `payload/` layout; inspect its `manifest.json` to locate each asset. Activation is separate: copy only reviewed assets to their original destinations while contained, using `config` or `workspace` maintenance for protected files. Do not overlay an entire archive onto a live `~/.openclaw`. Restore each SQLite database with its matching sidecars, never a mixture from different backups.

Restoring the configuration rarely beats re-seeding: the seed rebuilds `openclaw.json`, `secrets.json`, `~/.openclaw/.env`, `environment.d/` and the aligndev settings from the repository and `.env`. Prefer the backup for workspace files and the companions with their registry, which the seed does not write.

## Re-seed and validate

Follow [configure-assistant.md](configure-assistant.md) to re-seed through a contained maintenance window. Then follow [update-workspace.md](update-workspace.md) when the workspace files were touched.

## Start and verify

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- systemctl --user status openclaw-gateway
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project list'
```

Finish with the selected agent's verification/acceptance section in [08-coding-agent.md](../installations/08-coding-agent.md), the real-UID permission and authentication-renewal checks in [06](../installations/06-security-hardening.md#deployment-acceptance), and the smoke test of [07-channel.md](../installations/07-channel.md) before reopening the channel. For Pi, restart in the recorded approved parent and a new linked worktree to check trust, then verify package/tool identity without duplicate subagents. Rehearse reboot recovery separately. These are live deployment acceptance procedures, not checks performed by the offline template suite.
