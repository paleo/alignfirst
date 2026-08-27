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

## npm packages

The prefix is root-owned and immutable ([06](../installations/06-security-hardening.md)). The maintenance wrapper gives the service account this scope for the command, then restores root ownership, modes and the immutable flag through an `EXIT` trap. `openclaw update` is channel-aware and refreshes its plugins; the other packages ride `@latest`.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance packages -- bash -lc '
openclaw update --yes --no-restart
/usr/bin/npm install -g @paleo/alproject@latest @paleo/alcode@latest ctx7@latest
'
```

Update the coding agent through its package-scoped command: [08-coding-agent.md § Update](../installations/08-coding-agent.md#update).

`openclaw update` exits 1 when its post-install doctor attempts a config write, which the immutable `openclaw.json` blocks (`ENOTDIR: not a directory, scandir '…/openclaw.json'`). Exit 0 means no write was attempted. Either way the package update succeeded; the verify step is what counts.

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

## Gateway unit and restart

After an OpenClaw version bump, doctor may report a unit installed by an older version. `ExecStart` already points at the updated code. Refresh the stamp, then start the contained gateway:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance config -- \
  openclaw gateway install --force
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reload
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Smoke test

`--non-interactive` reports without applying anything:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
```

Config-schema warnings here mean the update shipped a migration that the immutable `openclaw.json` blocked. Re-run the seed flow of [configure-developer.md](configure-developer.md): `config set` under the new binary rewrites the config in the current schema. When warnings persist on keys the seed does not set, run interactive `openclaw doctor` through another `config` maintenance window and port the accepted changes into the seed modules.
