---
title: Configure the Assistant
read_when:
  - infra/openclaw/.env, aligndev.settings.json or a seed module changed
  - a secret was rotated
---

# Configure the Assistant

**Operator.** Re-seed when `infra/openclaw/.env`, `seed.sh`, `aligndev.settings.json` (the aligndev settings), a module under `seed/`, `environment.d/` or `coding-agent/` changed: a rotated token, a channel ID, the model provider or model, the skill allowlist, a new variable.

Before any writes, the shared inventory checks every provisioned profile and optional quota store, including custom directories and profiles selected only by a project registry. Use `configDir: null` for native-default mode or explicit isolated directory strings beneath the service home. Inventory paths remain absolute strings; native commands must unset the directory variable for null after shell initialization, or set the resolved explicit path for strings. Relative values resolve against the deployed settings directory, never this checkout. Symlinked anchors/non-package resources, escaping package links, padded paths, `file:` URLs, unsafe overlaps and HOME/session-root overrides fail closed.

Provision and authenticate each account separately. The selected overlay seeds instructions for its own agent kind; additional kinds require their own reviewed instructions and packages. All provisioned accounts are available to the service UID; the editable registry routes work and is not an authorization boundary. Child provider/model/authentication and quota account are independent of OpenClaw's model.

Changing the model never changes the agent runtime. Keep
`models.providers.<provider>.agentRuntime.id` set to `openclaw`; the assistant requires OpenClaw's
`exec` and `process` tools.

`openclaw.json` is immutable once [06](../installations/06-security-hardening.md) has run. The root-owned maintenance wrapper contains the assistant, refreshes the seed snapshot, unlocks only the requested paths, runs the seed, and restores the hardening policy through an `EXIT` trap.

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- \
  /home/{{SERVICE_USER}}/seed/seed.sh
```

When `infra/openclaw/coding-agent/*.md` changed ([08-coding-agent.md § Global Instructions](../installations/08-coding-agent.md#global-instructions)), include the instruction scope:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance config instructions -- \
  /home/{{SERVICE_USER}}/seed/seed.sh
```

When adding/removing profiles, changing native directories, Pi declarations/packages or saved trust, include all native scopes. Review old and new inventories before the window; the wrapper saves root-private resolved inventories for restoration:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance config instructions agent-skills agent-config -- \
  /home/{{SERVICE_USER}}/seed/seed.sh
```

This does not migrate credentials or sessions. Retain old private backups and stores until the new account works. Install Pi packages before declaring them in settings, within `agent-config` maintenance after hardening. Native `auth.json` and adjacent locks remain writable for renewal; other Pi declarations, including `trust.json`, require maintenance. Never unlock the entire native root.

Inspect every profile explicitly after seeding, without the cwd's registry selection:

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
jq -r '.code.profiles | keys[]' "$HOME/.alignfirst/aligndev.settings.json" |
  while IFS= read -r profile; do
    aligndev guide code --profile "$profile" --channel app
  done
EOS
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

Run these commands only after the wrapper reports that hardening was restored and exits 0. After a failure, follow [recovery](recover-assistant.md#failed-maintenance-cleanup). Failed recontainment leaves gateway state unknown; failed policy restoration retains the private inventory for operator repair.

## Scope

The seed writes `~/.openclaw/openclaw.json` through `openclaw config set`, creates `~/.openclaw/workspace/scratch/`, rewrites `~/.openclaw/secrets/secrets.json` and `~/.openclaw/.env` from `~/seed/.env`, installs `~/.config/environment.d/*.conf` and `~/.alignfirst/aligndev.settings.json`, creates `~/.alignfirst/companions/`, reserves managed resource paths and merges instructions in every store of the overlay's agent kind. It preserves text outside the managed block and user Pi `agents/` profiles. It does not touch:

- `~/.openclaw/workspace/*.md` — [update-workspace.md](update-workspace.md).
- `~/projects/.alignfirst-projects.json` — [update-assistant.md](update-assistant.md).
- The provider and coding-agent logins — [04 § 10](../installations/04-openclaw.md#10-provider-login), [08 § Authenticate](../installations/08-coding-agent.md#authenticate).
