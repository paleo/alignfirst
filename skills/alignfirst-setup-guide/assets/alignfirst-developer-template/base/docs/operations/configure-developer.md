---
title: Configure the Developer
read_when:
  - infra/openclaw/.env or a seed module changed
  - a secret was rotated
---

# Configure the Developer

**Operator.** Re-seed when `infra/openclaw/.env`, `seed.sh`, a module under `seed/`, `environment.d/` or `coding-agent/` changed: a rotated token, a channel ID, the runtime model, the skill allowlist, a new variable.

`openclaw.json` is immutable once [06](../installations/06-security-hardening.md) has run, so unflag it around the seed. While it is flagged, every config-writing command (`config set`, `plugins install`, the seed) fails, and not always legibly — see [gotchas.md](../gotchas.md#config-writing-commands-fail-while-openclawjson-is-immutable).

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo rsync -a --delete ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/ /home/{{SERVICE_USER}}/seed/
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/seed
sudo chattr -i /home/{{SERVICE_USER}}/.openclaw/openclaw.json
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/seed.sh
sudo -i -u {{SERVICE_USER}} -- openclaw config validate
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/openclaw.json
```

When `infra/openclaw/coding-agent/*.md` changed ([08-coding-agent.md § Global Instructions](../installations/08-coding-agent.md#global-instructions)), also unflag the coding agent's global instruction file before the seed and reflag it after — the pair of commands is in [08-coding-agent.md § Hardening](../installations/08-coding-agent.md#hardening). An unchanged file needs no unflag: the seed compares the merged content and writes nothing when it is identical.

## Apply

A secret-only change (a value in `secrets.json`, references unchanged) is hot-swapped:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw secrets reload
```

Every other change reaches new sessions on its own. Restart only when active sessions must see it too, or when `environment.d/` changed (then `daemon-reexec` first, [04 § 9](../installations/04-openclaw.md#9-environment-changes)):

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
```

## Scope

The seed writes `~/.openclaw/openclaw.json` through `openclaw config set`, creates `~/.openclaw/workspace/scratch/`, rewrites `~/.openclaw/secrets/secrets.json` and `~/.openclaw/.env` from `~/seed/.env`, installs `~/.config/environment.d/*.conf`, and merges the coding agent's global instruction file. It does not touch:

- `~/.openclaw/workspace/*.md` — [update-workspace.md](update-workspace.md).
- `~/.alproject.json` and `alproject-guide.md` — [update-developer.md](update-developer.md).
- The provider and coding-agent logins — [04 § 10](../installations/04-openclaw.md#10-provider-login), [08 § Authenticate](../installations/08-coding-agent.md#authenticate).
