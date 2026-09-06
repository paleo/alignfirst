---
title: OpenClaw Installation
read_when:
  - installing or re-seeding OpenClaw for the service account
  - filling infra/openclaw/.env, pairing the dashboard, rotating a secret
---

# OpenClaw Installation

**Operator**, after [05-openclaw-dependencies.md](05-openclaw-dependencies.md) and the platform part of [07-channel.md](07-channel.md) (it produces the channel tokens and IDs that `.env` needs); before [08-coding-agent.md](08-coding-agent.md). OpenClaw runs natively as `{{SERVICE_USER}}` and starts containers on behalf of the projects it manages; the gateway dashboard listens on loopback port 18789.

The seed assets live in `infra/openclaw/`:

```text
infra/openclaw/
├── .env.example        # every value the seed reads; copy to .env (gitignored)
├── seed.sh             # openclaw setup + openclaw config set …, secret store, environment.d
├── seed/               # common.sh, surface.sh, coding-agent.sh — the configuration modules
├── environment.d/      # non-secret variables for systemd --user and login shells
├── bin/                # workspace, backup, kill-switch and maintenance scripts
├── projects/           # .alignfirst-projects.json
├── workspace/          # curated workspace files (AGENTS.md, IDENTITY.md, …)
├── heartbeat-scratch.md # the heartbeat job's comment-only checklist (step 7)
└── coding-agent/       # global instruction file of the delegated coding agent
```

The service account never reads this checkout. It works from a snapshot at `~{{SERVICE_USER}}/seed/`, refreshed by the operator (step 2).

## 1. Fill `.env`

The checkout's `infra/openclaw/.env` is the canonical copy, gitignored:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}}
cp infra/openclaw/.env.example infra/openclaw/.env && chmod 600 infra/openclaw/.env
```

> **User action required.** Edit `infra/openclaw/.env`. The values come from the password manager and the provider dashboards, so the agent cannot fill it.

- `RUNTIME_PROVIDER`, `RUNTIME_MODEL` — pre-filled from the render.
- `RUNTIME_API_KEY` — when the provider authenticates by key; leave empty for an interactive login (step 10).
- `GATEWAY_AUTH_TOKEN` — `openssl rand -hex 32` on a fresh install; on an existing server, the current value (the `.env.example` comment shows how to read it back).
- `GATEWAY_DASHBOARD_ORIGIN` — keep the default for the SSH tunnel.
- `CONTEXT7_API_KEY` — from the Context7 dashboard.
- The channel tokens and IDs — from the platform part of [07-channel.md](07-channel.md).

Each variable carries a comment in `.env.example` saying where it comes from and which step consumes it.

## 2. Snapshot

Copies `infra/openclaw/`, `.env` included, and hands it over. Re-run it after every change under `infra/openclaw/`:

```sh
sudo rsync -a --delete ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/ /home/{{SERVICE_USER}}/seed/
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/seed
```

The execute bits are tracked by git; no `chmod` is needed.

## 3. Seed

`seed.sh` runs `openclaw setup` when `openclaw.json` is missing, so the configuration starts from the installed version's defaults, then applies every customization through `openclaw config set`, which validates each key and survives schema migrations. It derives `~/.openclaw/secrets/secrets.json` (0600) from `.env`, registers a file SecretRef provider and writes every credential into `openclaw.json` as a reference to it. It writes `CONTEXT7_API_KEY` alone into `~/.openclaw/.env`, the gateway env file inherited by exec children. It installs `environment.d/*.conf` into `~/.config/environment.d/` and generates `runtime.conf` there with `DOCKER_HOST`. `openclaw secrets audit` then fails the seed on any plaintext, unresolved or shadowed reference, or store residue (a provider OAuth login shows as an informational legacy-residue finding and passes), before `openclaw config validate` and an interactive `openclaw doctor`.

The provider and model are deployment choices. The seed always pins
`models.providers.{{RUNTIME_PROVIDER}}.agentRuntime.id` to `openclaw`. The embedded runtime owns the
turn and supplies the `exec` and `process` tools that the developer playbook uses. Keep this pin
when changing models.

```sh
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/seed.sh
sudo -i -u {{SERVICE_USER}} -- \
  openclaw config get models.providers.{{RUNTIME_PROVIDER}}.agentRuntime --json
# Expected: {"id":"openclaw"}
```

Once, on first install, apply doctor's auto-fixes to create the credential scaffolding (`~/.openclaw/credentials/`). The gateway token is not among them: it is a SecretRef, never generated.

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --fix
```

Later runs use plain `openclaw doctor` — see [gotchas.md](../gotchas.md).

## 4. Provider plugin

A model provider served by an OpenClaw plugin needs three more lines in `seed/common.sh`, next to `plugins.allow`:

```sh
install_plugin_once <package>
set_json plugins.allow "[\"$surface_plugin_id\",\"$RUNTIME_PROVIDER\",\"browser\",\"<id>\"]"
openclaw plugins enable "<id>" --accept-capabilities
```

`install_plugin_once` installs the package when no copy is present. `plugins enable` writes `plugins.entries.<id>.enabled` and records consent to the plugin's declared capabilities; a run without a TTY stops at the consent prompt otherwise. Consent is recorded per plugin version, so the seed re-records it on every run, as the surface module does for the channel plugin. Skip this step for a provider that OpenClaw serves natively.

An installed agent-harness plugin cannot claim this deployment's turns because the explicit
`openclaw` runtime pin is authoritative. A provider plugin may still supply model transport,
authentication, or chat commands.

## Model-specific parameters

The template leaves model parameters at OpenClaw's defaults. Before setting compaction thresholds,
context limits, service tiers, or other provider-specific parameters, follow the current
[official OpenClaw provider documentation](https://docs.openclaw.ai/providers). Route capabilities
and defaults change; do not copy values from another deployment.

## 5. Workspace files

`openclaw setup` populated `~/.openclaw/workspace/` with bare templates. The script backs them up to `~/backups/workspace-backups/<stamp>/` and writes the curated files from `~/seed/workspace/` over them:

```sh
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-workspace.sh
```

Later changes follow [update-workspace.md](../operations/update-workspace.md): once `06` has run, the files are immutable.

## 6. Projects marker

Create the fixed project parent, install its marker as a root-owned file, then verify that an empty listing exits 0.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'mkdir -p ~/projects'
sudo install -m 644 -o root -g root \
  /home/{{SERVICE_USER}}/seed/projects/.alignfirst-projects.json \
  /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
sudo -H -u {{SERVICE_USER}} bash -lc 'alproject list --root ~/projects'
```

Projects come later through [add-project.md](../operations/add-project.md).

## 7. Gateway unit

Enable lingering first, so a `systemd --user` manager exists for the account without a session and restarts the gateway at boot:

```sh
sudo loginctl enable-linger {{SERVICE_USER}}
loginctl show-user {{SERVICE_USER}} | grep Linger
# Expected: Linger=yes
```

`openclaw gateway install` writes the user unit: `ExecStart` points at the installed `dist/index.js`, and the current `PATH` is baked in as `Environment=PATH=`. With the `.bash_profile` of `03`, that is `/usr/bin:…:~/.npm-system-global/bin`, which is what lets exec children find `alignfirst`, `alcode`, and the coding agent.

The installer refuses group-writable unit paths, and the account's default umask creates them that way ([gotchas.md](../gotchas.md#gateway-install-refuses-group-writable-systemd-paths)). Strip the bit first:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'mkdir -p ~/.config/systemd/user && chmod go-w ~/.config ~/.config/systemd ~/.config/systemd/user'
sudo -i -u {{SERVICE_USER}} -- openclaw gateway install
sudo -i -u {{SERVICE_USER}} -- systemctl --user enable --now openclaw-gateway.service
sudo -i -u {{SERVICE_USER}} -- systemctl --user status openclaw-gateway.service
```

After an OpenClaw upgrade, refresh the unit (settings, node flags) with `--force`; the permission check now includes the unit file:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'chmod go-w ~/.config ~/.config/systemd ~/.config/systemd/user ~/.config/systemd/user/openclaw-gateway.service'
sudo -i -u {{SERVICE_USER}} -- openclaw gateway install --force
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reload
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
```

### Heartbeat scratch

The heartbeat checklist is the scratch of the system-owned `heartbeat:main` cron job, which the gateway creates at its first start from `agents.defaults.heartbeat.every`. `apply-heartbeat-scratch.sh` pushes the comment-only text from the snapshot when the live scratch differs from it:

```sh
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-heartbeat-scratch.sh
```

A comment-only scratch makes the daily tick skip its model call ([gotchas.md](../gotchas.md#heartbeat-cost-is-a-main-session-problem)). The scratch carries no immutable flag; `06` records the accepted gap.

## 8. Podman socket

`DOCKER_HOST` is already in `~/.config/environment.d/runtime.conf`; the socket it names comes from the user manager (lingering keeps it across reboots):

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user enable --now podman.socket
sudo -i -u {{SERVICE_USER}} -- bash -lc 'docker version'
# Expected: the Server section reports Podman Engine
```

## 9. Environment changes

`~/.config/environment.d/*.conf` is installed by the seed. After a change, re-exec the user manager so it rebuilds its environment block, then restart the gateway so the running process inherits it:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reexec
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
```

Verify on both sides, the gateway (systemd-injected) and the login shell (`.bash_profile`-sourced):

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user show-environment | grep -E '^(PROJECT_DEV_LIMIT|DOCKER_HOST)='
pid=$(sudo -i -u {{SERVICE_USER}} -- systemctl --user show -p MainPID --value openclaw-gateway)
sudo cat /proc/$pid/environ | tr '\0' '\n' | grep -E '^(PROJECT_DEV_LIMIT|DOCKER_HOST)='
sudo -i -u {{SERVICE_USER}} -- env | grep -E '^(PROJECT_DEV_LIMIT|DOCKER_HOST)='
```

## 10. Provider login

Skip when `RUNTIME_API_KEY` is set. Otherwise the provider's interactive login needs a TTY; `openclaw models auth login` refuses to run without one.

> **User action required.** In a fresh SSH terminal as `{{SERVER_ADMIN_USER}}`, open an interactive service-account shell and complete the browser flow on the laptop, signed in to the account that funds the developer:
>
> ```sh
> sudo -i -u {{SERVICE_USER}}
> openclaw models auth login --provider {{RUNTIME_PROVIDER}}
> openclaw models status
> exit
> ```

The provider's login flags (device code, browser callback) are listed by `openclaw models auth login --help`. Never move credentials through shell history, chat or a tracked file.

## 11. Dashboard

The gateway listens on loopback with token auth. The Control UI needs a secure context for its device identity, which over plain HTTP only `localhost` provides, hence the tunnel. `openclaw.json` holds a reference; the value sits in the secret store:

```sh
sudo -u {{SERVICE_USER}} jq -r .GATEWAY_AUTH_TOKEN /home/{{SERVICE_USER}}/.openclaw/secrets/secrets.json
```

> **User action required.** From the laptop, keep the tunnel running while using the dashboard, open `http://localhost:18789/`, paste the token, and store it in the password manager:
>
> ```sh
> ssh -N -L 18789:127.0.0.1:18789 {{SERVER_ADMIN_USER}}@<vps-ip>
> ```

The bearer token grants the pairing scope on first connect, so the browser is paired without approval. Verify, and approve a pending request when one is listed:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw devices list
sudo -i -u {{SERVICE_USER}} -- openclaw devices approve <request-id>
```

## 12. Reboot check

> **User action required.** The reboot ends the agent's SSH session, so this runs from the laptop:
>
> ```sh
> ssh {{SERVER_ADMIN_USER}}@<vps-ip> 'sudo reboot'
> # after ~30 s
> ssh {{SERVER_ADMIN_USER}}@<vps-ip> 'sudo -i -u {{SERVICE_USER}} -- systemctl --user status openclaw-gateway.service'
> ```

Continue with [08-coding-agent.md](08-coding-agent.md).

## Day-to-day

```sh
sudo -i -u {{SERVICE_USER}} -- journalctl --user -u openclaw-gateway -f
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- openclaw plugins list
sudo -i -u {{SERVICE_USER}} -- openclaw doctor          # interactive; no --fix, see gotchas.md
sudo -i -u {{SERVICE_USER}} -- openclaw secrets reload   # after a secret rotation
```

Upgrades: [update-developer.md](../operations/update-developer.md). Configuration changes: [configure-developer.md](../operations/configure-developer.md).

## Rotating a secret

Edit the value in the checkout's `infra/openclaw/.env`. Before `06`, refresh the snapshot and re-run the seed. After `06`, follow [configure-developer.md](../operations/configure-developer.md); its root-owned wrapper contains the developer and restores the locked configuration.

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw secrets reload  # before 06 only
```
