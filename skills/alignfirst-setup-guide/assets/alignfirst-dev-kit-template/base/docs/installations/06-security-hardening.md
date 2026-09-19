---
title: Security Hardening
read_when:
  - locking the service account's configuration, workspace, skills and packages
  - a write by the service account fails with "Operation not permitted" or EACCES
  - stopping the claw immediately (kill switch)
---

# Security Hardening

**Operator**, last in the execution order: after [04-openclaw.md](04-openclaw.md), [07-channel.md](07-channel.md) and [08-coding-agent.md](08-coding-agent.md), because it locks paths those runbooks write. The surface smoke test of `07` follows.

<!-- DEV_SERVER_GATEWAY_SECTION -->
[09-dev-server-gateway.md](09-dev-server-gateway.md) also runs before this runbook.
<!-- DEV_SERVER_GATEWAY_SECTION -->

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

`{{SERVICE_USER}}` has no sudo, so filesystem permissions are a guarantee, not an instruction. Two mechanisms: `chattr +i` (the owner can neither modify nor delete the file; only root removes the flag), and ownership handoff to `root` or `{{SERVER_ADMIN_USER}}` with the write bits stripped. Each locked directory root that sits in a service-writable parent is flagged as well; otherwise the tree could be renamed and recreated writable.

The claw can no longer edit its own instruction files or protected global packages. Its improvement path is a proposal, reviewed and applied through this repository. Memory, sessions, logs, `workspace/scratch/`, and project-runtime globals stay writable.

## Install the maintenance controls

Install the kill switch and maintenance wrapper outside the service account's writable paths, then contain the claw before changing the hardening policy:

```sh
sudo install -m 755 -o root -g root \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/claw-kill.sh \
  /usr/local/sbin/alignfirst-claw-kill
sudo install -m 755 -o root -g root \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/claw-maintenance.sh \
  /usr/local/sbin/alignfirst-claw-maintenance
sudo /usr/local/sbin/alignfirst-claw-kill
```

## Configuration and workspace files

The workspace was applied during `04`. If it has changed since then, run [update-workspace.md](../operations/update-workspace.md), then rerun the kill switch before continuing.

```sh
sudo chown {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/.openclaw/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
sudo chmod 600 /home/{{SERVICE_USER}}/.openclaw/openclaw.json
sudo chmod 644 /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
```

Accepted gap: the heartbeat checklist is the `heartbeat:main` cron job's scratch, a SQLite row ([04 § 7](04-openclaw.md#heartbeat-scratch)). No flag protects it; the agent can rewrite it through `heartbeat_respond` or `openclaw cron scratch --set`. It joins the agent-written state the policy tolerates (memory, sessions), its reach is the daily tick, and [update-claw.md](../operations/update-claw.md#smoke-test) restores it.

The projects marker is repository-managed and immutable:

```sh
sudo chown root:root /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
sudo chmod 644 /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
sudo chattr +i /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
```

## Skills and instructions

The setup guide and `sharp-writing` under `~/.agents/skills/` feed both OpenClaw and the delegated coding agent. Only OpenClaw automatically discovers the playbook under `~/.openclaw/skills/`. The commands below protect both trees from service-account writes: admin ownership and modes prevent content changes; the immutable flag on each root prevents its removal or replacement. Both agents can still read the files. `~/.openclaw` stays writable for gateway state.

```sh
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.agents
sudo find /home/{{SERVICE_USER}}/.agents -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.agents -type f -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.agents
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.openclaw/skills
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -type f -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/skills
```

The coding agent's own skill directory and global instruction file: [08-coding-agent.md § Hardening](08-coding-agent.md#hardening).

## Runtime launchers

The launchers and initialization files under `/opt/{{SERVICE_USER}}/` are root-owned. The gateway drop-in remains service-owned because `openclaw gateway install` refuses a unit definition owned by another user.

```sh
sudo chown -R root:root /opt/{{SERVICE_USER}}
sudo find /opt/{{SERVICE_USER}} -type d -exec chmod 755 {} +
sudo chmod 755 /opt/{{SERVICE_USER}}/bin/openclaw \
  /opt/{{SERVICE_USER}}/libexec/project-shell \
  /opt/{{SERVICE_USER}}/libexec/admin-npm \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
sudo chmod 644 /opt/{{SERVICE_USER}}/libexec/init.bash
sudo chown {{SERVICE_USER}}:{{SERVICE_USER}} \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d/20-system-node-path.conf
sudo chmod 644 \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d/20-system-node-path.conf
```

## Global packages

`~/.npm-system-global/` holds `openclaw`, the coding agent, `alignfirst`, `@alignfirst/alcode`, `@alignfirst/alproject` and `ctx7`. It is root-owned and immutable. A global install by the service account instead lands in its selected fnm runtime. The audited PATH keeps that writable runtime from shadowing `openclaw`, `alcode` or the coding agent.

```sh
sudo chown -R root:root /home/{{SERVICE_USER}}/.npm-system-global
sudo chmod -R go-w /home/{{SERVICE_USER}}/.npm-system-global
sudo chattr +i /home/{{SERVICE_USER}}/.npm-system-global
```

### Project-runtime audit

Accepted trade-off: the service-writable fnm bin precedes system tools in project shells, so it can shadow commands such as `git`, `curl` or `ssh` for the same Linux user. The protected CLI paths stay ahead of it. This is an operational audit, not an integrity guarantee for service-owned tools.

Inspect every installed runtime, including inactive versions. The bin listing exposes manually added files and symlinks as well as npm-installed commands; compare the package listing with the development tools intended for that version:

```sh
sudo -H -u {{SERVICE_USER}} bash --noprofile --norc <<'EOS'
set -e
audit_status=0
for runtime in "$HOME"/.local/share/fnm/node-versions/*/installation; do
  [ -d "$runtime" ] || continue
  printf '\nRuntime: %s\n' "$runtime"
  /usr/bin/find "$runtime/bin" -mindepth 1 -maxdepth 1 -printf '%f -> %l\n' || audit_status=1
  /usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js --prefix "$runtime" ls -g --depth=0 || audit_status=1
done
exit "$audit_status"
EOS
```

## Unlocking for maintenance

Use `/usr/local/sbin/alignfirst-claw-maintenance`. It accepts only named scopes: `config`, `workspace`, `packages`, `skills`, `projects`, `instructions` and `agent-skills`. Before an unlock, it contains the account and refreshes `~/seed/` from this repository. Its `EXIT` trap contains the account again and restores ownership, modes and immutable flags on success, failure or interruption. The gateway stays stopped.

The operation runbooks supply the scopes and service-account command. Start the gateway only after the wrapper reports that hardening was restored and exits 0.

## Kill switch

The installed kill switch stops the gateway, stops and kills every rootless container, then terminates every service-account process regardless of its executable name. Only the `systemd --user` manager and its `(sd-pam)` process may survive. The script fails when a container, the gateway or another process survives.

```sh
sudo /usr/local/sbin/alignfirst-claw-kill
# recovery:
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Verification

As the service account, every write must fail with `Operation not permitted` or `Permission denied`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/workspace/AGENTS.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/openclaw.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/projects/.alignfirst-projects.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'touch ~/.openclaw/skills/alignfirst-openclaw-playbook/SKILL.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.agents ~/.agents-x'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.openclaw/skills ~/.openclaw/skills-x'
```

A project-runtime global install must succeed and leave the protected launcher selected. The trap removes the test package on success or failure. If this runtime already contains `cowsay`, use a clean test runtime to preserve that installation:

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -e
cd "$HOME"
runtime_prefix=$(readlink -f "${FNM_MULTISHELL_PATH:?}")
npm_prefix=$(npm prefix -g)
test "$(readlink -f "$npm_prefix")" = "$runtime_prefix"
test ! -e "$(npm root -g)/cowsay"
test ! -L "$(npm root -g)/cowsay"
for name in cowsay cowthink; do
  test ! -e "$runtime_prefix/bin/$name" && test ! -L "$runtime_prefix/bin/$name"
done
trap 'npm uninstall -g cowsay' EXIT
npm install -g cowsay
test "$(command -v openclaw)" = /opt/{{SERVICE_USER}}/bin/openclaw
command -v openclaw
EOS
# Expected: /opt/{{SERVICE_USER}}/bin/openclaw
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm ls -g --depth=0
# Expected: exactly openclaw, the coding agent, alignfirst, @alignfirst/alcode, @alignfirst/alproject and ctx7
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
ALIGNFIRST_CODE_AGENT=<claude|codex> \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

Still working: reads of the instructions, skills and project listing; writes under `~/.openclaw/workspace/scratch/`; project-level and fnm-runtime global npm installs; the coding agent's authentication and session state.

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

Start the gateway before that smoke test:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```
