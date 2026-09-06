---
title: Update the Developer
read_when:
  - upgrading OpenClaw, the coding agent, alcode, alproject, ctx7 or the skills
---

# Update the Developer

**Operator.** Every step is idempotent; re-apply all of them. Each maintenance window contains the developer before an unlock and leaves the gateway stopped. Configuration changes are a different runbook: [configure-developer.md](configure-developer.md).

Open a report in `.reports/` and record the versions the verify step prints.

## Maintenance controls

Pull the repository and reinstall its root-owned controls before opening any maintenance window:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo install -m 755 -o root -g root infra/openclaw/bin/developer-kill.sh \
  /usr/local/sbin/alignfirst-developer-kill
sudo install -m 755 -o root -g root infra/openclaw/bin/developer-maintenance.sh \
  /usr/local/sbin/alignfirst-developer-maintenance
```

## Back up

Before a core bump, stop the gateway so both OpenClaw and the independent thread-handoff database
close consistently, then keep the state the migrations will rewrite
([recover-developer.md](recover-developer.md#restore)):

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user stop openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh
```

## npm packages

The prefix is root-owned and immutable ([06](../installations/06-security-hardening.md)). The maintenance wrapper gives the service account this scope for the command, then restores root ownership, modes and the immutable flag through an `EXIT` trap. `openclaw update` is channel-aware and refreshes its plugins at the core's version; the other packages ride `@latest`.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance packages -- bash -lc '
openclaw update --yes --no-restart --accept-capabilities
openclaw plugins update thread-handoff --accept-capabilities
/usr/bin/npm install -g @paleo/alproject@latest @paleo/alcode@latest ctx7@latest
'
```

`--accept-capabilities` accepts the plugins' reviewed capability changes. Without it the post-update plugin sync stops with an unresolved review, which `openclaw update repair --accept-capabilities` finishes.

`thread-handoff` is an independent npm plugin, so its explicit update is separate from the core and
official channel-plugin update. Its state directory remains in place across package replacement.

Update the coding agent through its package-scoped command: [08-coding-agent.md § Update](../installations/08-coding-agent.md#update).

`openclaw update` exits 1 when its post-install doctor attempts a config write, which the immutable `openclaw.json` blocks (`ENOTDIR: not a directory, scandir '…/openclaw.json'`). Exit 0 means no write was attempted. Either way the package update succeeded; the verify step is what counts, and the migration step below finishes what the lock interrupted.

Verify — the listing must show exactly five packages (`openclaw`, the coding agent, `@paleo/alproject`, `@paleo/alcode`, `ctx7`); anything else is a stray from a mistyped install, to remove through another `packages` maintenance window:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'openclaw --version && alproject --version && alcode --help >/dev/null && echo alcode-ok && ctx7 --version && npm ls -g --depth=0'
```

## Skills

The canonical skills tree is admin-owned and immutable. The `skills` scope also covers Claude Code's symlink tier when selected.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- \
  bash -lc 'npx -y skills update -g -y </dev/null'
```

Then make sure every target exists. If an entry is missing, repeat the idempotent `skills add` block of [08-coding-agent.md § Skills](../installations/08-coding-agent.md#skills), replacing its opening command with:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- bash <<'EOS'
```

Sweep the escaped symlinks the `skills` CLI writes into `~/.openclaw/skills/` ([gotchas.md](../gotchas.md#skills-cli-writes-escaped-symlinks-under-openclawskills)). Run it as a separate command: the symlink writes lag the CLI's return, so a sweep chained in the same heredoc deletes nothing.

```sh
sudo -i -u {{SERVICE_USER}} -- find /home/{{SERVICE_USER}}/.openclaw/skills -maxdepth 1 -type l -print -delete
```

`~/.agents/skills/` is shared between OpenClaw and the coding agent; the `al*` command skills there are not orphans — see [gotchas.md](../gotchas.md#agentsskills-is-shared-between-openclaw-and-the-coding-agent).

## Seed snapshot and alproject files

The wrapper refreshes the contained seed snapshot before each unlock.

Reinstall the repository-managed alproject configuration and guide; the registry is mutable state and is left alone:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance alproject -- bash -lc '
projects_root=$(echo {{PROJECTS_ROOT}})
install -m 644 ~/seed/alproject/.alproject.json ~/.alproject.json
install -m 644 ~/seed/alproject/alproject-guide.md "$projects_root/alproject-guide.md"
alproject list
'
```

Workspace files follow [update-workspace.md](update-workspace.md).

## Migrate after a core bump

A release can ship state migrations that only doctor's repair mode applies, with or without a TTY. `openclaw update repair` runs that repair, syncs the plugins at the core's version and refreshes the plugin registry; it needs the configuration and the workspace writable:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance config workspace -- \
  openclaw update repair --yes --accept-capabilities
```

Read its output: every imported or removed file is a change to port into the repository.

## Re-seed after a core bump

A new OpenClaw release can retire keys the seed sets, turn on new defaults and widen the channel plugin's declared capabilities. Re-seed through [configure-developer.md](configure-developer.md): `config set` under the new binary rewrites the config in the current schema, and the surface module re-records the plugin consent. A `config set` that fails names a retired key; the trailing interactive `openclaw doctor` shows the new defaults. Port both into the seed modules before starting the gateway.

## Gateway unit and restart

After an OpenClaw version bump, doctor may report a unit installed by an older version. `ExecStart` already points at the updated code. Refresh the unit, then start the contained gateway. The installer refuses group-writable paths ([gotchas.md](../gotchas.md#gateway-install-refuses-group-writable-systemd-paths)), hence the `chmod`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'chmod go-w ~/.config ~/.config/systemd ~/.config/systemd/user ~/.config/systemd/user/openclaw-gateway.service'
sudo /usr/local/sbin/alignfirst-developer-maintenance config -- \
  openclaw gateway install --force
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reload
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Smoke test

`--non-interactive` reports without applying anything:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
sudo -i -u {{SERVICE_USER}} -- openclaw cron list --all
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-heartbeat-scratch.sh
```

Config-schema warnings here mean a migration that the seed has not ported yet: back to the re-seed step. A repair doctor still proposes after the gateway ran (an orphaned session binding, for instance) needs one more migration window. The job list must show `heartbeat:main` as the only enabled system-owned job; another one is a default the release turned on, to opt out of in `seed/common.sh` ([gotchas.md](../gotchas.md#openclaw-schedules-background-model-runs-on-its-own)). `apply-heartbeat-scratch.sh` reports the scratch unchanged, or pushes `infra/openclaw/heartbeat-scratch.md` back when the release or the agent rewrote it ([04 § 7](../installations/04-openclaw.md#heartbeat-scratch)).

Once the release has run for a while, `openclaw update cleanup --dry-run` (gateway stopped) previews the retirement of the archived pre-migration files; run it without `--dry-run` to reclaim the space.
