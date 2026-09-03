---
title: Configure the Developer
read_when:
  - infra/openclaw/.env or a seed module changed
  - a secret was rotated
---

# Configure the Developer

**Operator.** Re-seed when `infra/openclaw/.env`, `seed.sh`, a module under `seed/`, `environment.d/` or `coding-agent/` changed: a rotated token, a channel ID, the model provider or model, the skill allowlist, a new variable.

Changing the model never changes the agent runtime. Keep
`models.providers.<provider>.agentRuntime.id` set to `openclaw`; the developer requires OpenClaw's
`exec` and `process` tools.

`openclaw.json` is immutable once [06](../installations/06-security-hardening.md) has run. The root-owned maintenance wrapper contains the developer, refreshes the seed snapshot, unlocks only the requested paths, runs the seed, and restores the hardening policy through an `EXIT` trap.

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo /usr/local/sbin/alignfirst-developer-maintenance config -- \
  /home/{{SERVICE_USER}}/seed/seed.sh
```

When `infra/openclaw/coding-agent/*.md` changed ([08-coding-agent.md § Global Instructions](../installations/08-coding-agent.md#global-instructions)), include the instruction scope:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance config instructions -- \
  /home/{{SERVICE_USER}}/seed/seed.sh
```

## Apply

A successful maintenance window leaves the gateway stopped. When `environment.d/` changed, rebuild the user manager's environment first. Then start the gateway:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reexec  # environment.d changes only
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- \
  openclaw config get models.providers.{{RUNTIME_PROVIDER}}.agentRuntime --json
# Expected: {"id":"openclaw"}
```

Run these commands only after the wrapper reports that hardening was restored and exits 0. A failure leaves the developer contained for diagnosis.

## Scope

The seed writes `~/.openclaw/openclaw.json` through `openclaw config set`, creates `~/.openclaw/workspace/scratch/`, rewrites `~/.openclaw/secrets/secrets.json` and `~/.openclaw/.env` from `~/seed/.env`, installs `~/.config/environment.d/*.conf`, and merges the coding agent's global instruction file. It does not touch:

- `~/.openclaw/workspace/*.md` — [update-workspace.md](update-workspace.md).
- `~/projects/.alignfirst-projects.json` — [update-developer.md](update-developer.md).
- The provider and coding-agent logins — [04 § 10](../installations/04-openclaw.md#10-provider-login), [08 § Authenticate](../installations/08-coding-agent.md#authenticate).
