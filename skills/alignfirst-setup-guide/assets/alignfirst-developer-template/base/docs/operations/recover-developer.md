---
title: Recover the Developer
read_when:
  - the developer misbehaves and must be stopped
  - restoring the service after a failed update or a broken configuration
---

# Recover the Developer

**Operator.** Contain first, then diagnose, restore, re-authenticate when needed, re-seed, verify. Record the incident in `.reports/`.

## Contain

The kill switch stops the gateway unit and terminates the remaining agent processes; the user manager stays up:

```sh
sudo ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/developer-kill.sh
ps -u {{SERVICE_USER}}
```

## Diagnose

```sh
sudo -i -u {{SERVICE_USER}} -- journalctl --user -u openclaw-gateway --since "-2h" --no-pager | tail -200
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
sudo -i -u {{SERVICE_USER}} -- openclaw config validate
```

A delegated run leaves its session file under the project's `.plans/<ticket>/_alcode/`; read it before restoring anything. `exitReason: auth_required` means the coding agent's login expired — [08-coding-agent.md § Authenticate](../installations/08-coding-agent.md#authenticate). A provider error means the runtime login — [04 § 10](../installations/04-openclaw.md#10-provider-login). Keep the failed files.

## Restore

`backup.sh` copies the deployment state before every risky operation; run it now as well, so the broken state is kept:

```sh
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh
sudo -i -u {{SERVICE_USER}} -- ls /home/{{SERVICE_USER}}/backups/deployment/
```

A backup at `~/backups/deployment/<stamp>/` is flat. Each file goes back to one place, and the locked ones need an unflag first:

| Backup file | Live path | Unflag |
| --- | --- | --- |
| `openclaw.json` | `~/.openclaw/openclaw.json` | `chattr -i` |
| `secrets.json` | `~/.openclaw/secrets/secrets.json` | — |
| `openclaw.env` | `~/.openclaw/.env` | — |
| `workspace/*.md` | `~/.openclaw/workspace/` | `chattr -i` on the six files |
| `environment.d/*.conf` | `~/.config/environment.d/` | — |
| `alproject-registry.json` | `{{PROJECTS_ROOT}}/alproject-registry.json` | — |

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.openclaw/openclaw.json
sudo -i -u {{SERVICE_USER}} -- install -m 600 /home/{{SERVICE_USER}}/backups/deployment/<stamp>/openclaw.json /home/{{SERVICE_USER}}/.openclaw/openclaw.json
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/openclaw.json
```

Restoring the configuration rarely beats re-seeding: the seed rebuilds `openclaw.json`, `secrets.json`, `~/.openclaw/.env` and `environment.d/` from the repository and `.env`. Prefer the backup for the workspace files and the registry, which the seed does not write.

## Re-seed and validate

Follow [configure-developer.md](configure-developer.md): snapshot, unflag, seed, `config validate`, reflag. Then [update-workspace.md](update-workspace.md) when the workspace files were touched.

## Start and verify

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- systemctl --user status openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- alproject list
```

Finish with [08-coding-agent.md § Verification](../installations/08-coding-agent.md#verification) and the smoke test of [07-channel.md](../installations/07-channel.md) before reopening the channel to users.
