---
title: Update the Developer
read_when:
  - upgrading OpenClaw, the coding agent, alcode, alproject, ctx7 or the skills
---

# Update the Developer

**Operator.** Every step is idempotent; re-apply all of them. The gateway restarts once, at the end; active sessions keep their snapshot until then. Configuration changes are a different runbook: [configure-developer.md](configure-developer.md).

Open a report in `.reports/` and record the versions the verify step prints.

## npm packages

The prefix is root-owned and immutable ([06](../installations/06-security-hardening.md)); hand it back for the update, re-lock after. `openclaw update` is channel-aware and refreshes its plugins; the other packages ride `@latest`.

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.npm-system-global
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/.npm-system-global

sudo -i -u {{SERVICE_USER}} -- openclaw update --yes --no-restart
sudo -i -u {{SERVICE_USER}} -- /usr/bin/npm install -g @paleo/alproject@latest @paleo/alcode@latest ctx7@latest
```

The coding agent's line: [08-coding-agent.md § Update](../installations/08-coding-agent.md#update). Then re-lock:

```sh
sudo chown -R root:root /home/{{SERVICE_USER}}/.npm-system-global
sudo chmod -R go-w /home/{{SERVICE_USER}}/.npm-system-global
sudo chattr +i /home/{{SERVICE_USER}}/.npm-system-global
```

`openclaw update` exits 1 when its post-install doctor attempts a config write, which the immutable `openclaw.json` blocks (`ENOTDIR: not a directory, scandir '…/openclaw.json'`). Exit 0 means no write was attempted. Either way the package update succeeded; the verify step is what counts.

Verify — the listing must show exactly five packages (`openclaw`, the coding agent, `@paleo/alproject`, `@paleo/alcode`, `ctx7`); anything else is a stray from a mistyped install, to remove inside a new unlock window:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'openclaw --version && alproject --version && alcode --help >/dev/null && echo alcode-ok && ctx7 --version && npm ls -g --depth=0'
```

## Skills

The canonical skills tree is admin-owned and immutable; hand it back for the update. The agent's own tier has the same pair of commands in [08-coding-agent.md § Update](../installations/08-coding-agent.md#update).

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.agents
sudo chown -Rh {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/.agents
sudo -i -u {{SERVICE_USER}} -- npx -y skills update -g -y </dev/null
```

Then make sure every target exists: the `skills add` commands of [08-coding-agent.md § Skills](../installations/08-coding-agent.md#skills) are idempotent.

Sweep the escaped symlinks the `skills` CLI writes into `~/.openclaw/skills/` ([gotchas.md](../gotchas.md#skills-cli-writes-escaped-symlinks-under-openclawskills)). Run it as a separate command: the symlink writes lag the CLI's return, so a sweep chained in the same heredoc deletes nothing.

```sh
sudo -i -u {{SERVICE_USER}} -- find /home/{{SERVICE_USER}}/.openclaw/skills -maxdepth 1 -type l -print -delete
```

Re-lock:

```sh
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.agents
sudo find /home/{{SERVICE_USER}}/.agents -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.agents -type f -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.agents
```

`~/.agents/skills/` is shared between OpenClaw and the coding agent; the `al*` command skills there are not orphans — see [gotchas.md](../gotchas.md#agentsskills-is-shared-between-openclaw-and-the-coding-agent).

## Seed snapshot and alproject files

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo rsync -a --delete ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/ /home/{{SERVICE_USER}}/seed/
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/seed
```

Reinstall the repository-managed alproject configuration and guide; the registry is mutable state and is left alone:

```sh
projects_root=$(sudo -H -u {{SERVICE_USER}} bash -lc 'echo {{PROJECTS_ROOT}}')
sudo chattr -i /home/{{SERVICE_USER}}/.alproject.json "$projects_root/alproject-guide.md"
sudo install -m 644 -o root -g root /home/{{SERVICE_USER}}/seed/alproject/.alproject.json /home/{{SERVICE_USER}}/.alproject.json
sudo install -m 644 -o root -g root /home/{{SERVICE_USER}}/seed/alproject/alproject-guide.md "$projects_root/alproject-guide.md"
sudo chattr +i /home/{{SERVICE_USER}}/.alproject.json "$projects_root/alproject-guide.md"
sudo -i -u {{SERVICE_USER}} -- alproject list
```

Workspace files follow [update-workspace.md](update-workspace.md).

## Gateway unit and restart

After an OpenClaw version bump, doctor may report a unit installed by an older version. `ExecStart` already points at the updated code; refresh the stamp, then restart — the restart is what makes everything above visible to new sessions:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw gateway install --force
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reload
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
```

## Smoke test

`--non-interactive` reports without applying anything:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
```

Config-schema warnings here mean the update shipped a migration that the immutable `openclaw.json` blocked. Re-run the seed flow of [configure-developer.md](configure-developer.md): `config set` under the new binary rewrites the config in the current schema. When warnings persist on keys the seed does not set, run interactive `openclaw doctor` inside the same unflag window and port the accepted changes into the seed modules.
