---
title: Security Hardening
read_when:
  - locking the service account's configuration, workspace, skills and packages
  - a write by the service account fails with "Operation not permitted" or EACCES
  - stopping the developer immediately (kill switch)
---

# Security Hardening

**Operator**, last in the execution order: after [04-openclaw.md](04-openclaw.md), [07-channel.md](07-channel.md) and [08-coding-agent.md](08-coding-agent.md), because it locks paths those runbooks write. The surface smoke test of `07` follows.

<!-- DEV_SERVER_GATEWAY_SECTION -->
[09-dev-server-gateway.md](09-dev-server-gateway.md) also runs before this runbook.
<!-- DEV_SERVER_GATEWAY_SECTION -->

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

`{{SERVICE_USER}}` has no sudo, so filesystem permissions are a guarantee, not an instruction. Two mechanisms: `chattr +i` (the owner can neither modify nor delete the file; only root removes the flag), and ownership handoff to `root` or `{{SERVER_ADMIN_USER}}` with the write bits stripped. Each locked directory root that sits in a service-writable parent is flagged as well; otherwise the tree could be renamed and recreated writable.

The developer can no longer edit its own instruction files or install global packages. Its improvement path is a proposal, reviewed and applied through this repository. Memory, sessions, logs and `workspace/scratch/` stay writable.

## Configuration and workspace files

Run [update-workspace.md](../operations/update-workspace.md) once first, so the live files match the repository. `TOOLS.md` is empty and `HEARTBEAT.md` comment-only, and both are locked all the same — see [gotchas.md](../gotchas.md).

```sh
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER,TOOLS,HEARTBEAT}.md
```

The alproject configuration and guide are repository-managed; the registry stays service-owned and writable:

```sh
projects_root=$(sudo -H -u {{SERVICE_USER}} bash -lc 'echo {{PROJECTS_ROOT}}')
sudo chown root:root /home/{{SERVICE_USER}}/.alproject.json "$projects_root/alproject-guide.md"
sudo chmod 644 /home/{{SERVICE_USER}}/.alproject.json "$projects_root/alproject-guide.md"
sudo chattr +i /home/{{SERVICE_USER}}/.alproject.json "$projects_root/alproject-guide.md"
```

## Skills and instructions

The canonical skills at `~/.agents/skills/` feed both OpenClaw and the delegated coding agent, so the tree belongs to the admin account:

```sh
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.agents
sudo find /home/{{SERVICE_USER}}/.agents -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.agents -type f -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.agents
```

The coding agent's own skill directory and global instruction file: [08-coding-agent.md § Hardening](08-coding-agent.md#hardening).

## Global packages

`~/.npm-system-global/` holds `openclaw`, the coding agent, `@paleo/alcode`, `@paleo/alproject` and `ctx7`. Contract: as the service account, `npm install -g` fails with `EACCES`; project-level installs still work.

```sh
sudo chown -R root:root /home/{{SERVICE_USER}}/.npm-system-global
sudo chmod -R go-w /home/{{SERVICE_USER}}/.npm-system-global
sudo chattr +i /home/{{SERVICE_USER}}/.npm-system-global
```

## Unlocking for maintenance

Every write to a locked path follows unflag → apply → reflag. The sequences live where they are used: [configure-developer.md](../operations/configure-developer.md) (`openclaw.json`, the instruction file), [update-developer.md](../operations/update-developer.md) (npm prefix, skills, alproject files), [update-workspace.md](../operations/update-workspace.md) (workspace files).

## Kill switch

`developer-kill.sh` stops the gateway unit, then terminates the remaining agent processes of the account (`node`, the coding agent, `alcode`; rootless containers run under the same uid). The `systemd --user` manager stays up.

```sh
sudo ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/developer-kill.sh
# recovery:
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Verification

As the service account, every write must fail with `Operation not permitted` or `Permission denied`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/workspace/AGENTS.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/openclaw.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.alproject.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> {{PROJECTS_ROOT}}/alproject-guide.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'touch ~/.agents/skills/alignfirst/SKILL.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.agents ~/.agents-x'
sudo -i -u {{SERVICE_USER}} -- /usr/bin/npm install -g cowsay
```

Still working: reads of the instructions and skills, `alproject register`/`unregister`, writes under `~/.openclaw/workspace/scratch/`, `npm install` inside a project, the coding agent's authentication and session state.

Rootless podman closes the bind-mount bypass: container root maps to the service account, which cannot override the flag.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'podman run --rm -v ~/.openclaw/openclaw.json:/x:rw docker.io/library/alpine sh -c "echo x >> /x"'
# Expected: cannot create /x: Operation not permitted
```

After a reboot, the flags survive and the gateway and `podman.socket` return through lingering:

```sh
sudo lsattr /home/{{SERVICE_USER}}/.openclaw/openclaw.json /home/{{SERVICE_USER}}/.openclaw/workspace/*.md
sudo -i -u {{SERVICE_USER}} -- systemctl --user is-active openclaw-gateway podman.socket
```

Finish with [08-coding-agent.md § Verification](08-coding-agent.md#verification), then the smoke test of [07-channel.md](07-channel.md).
