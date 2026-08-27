---
title: Overview
read_when:
  - starting any task in this repository
  - tracing a request from the channel to a project
---

# Overview

## Identity

- **Host:** `{{SERVER_HOST}}`, Ubuntu 24.04, time zone `{{TIME_ZONE}}`.
- **Admin account:** `{{SERVER_ADMIN_USER}}` (sudo, key-only SSH). Holds this repository at `~/{{ADMIN_REPOSITORY_NAME}}`.
- **Service account:** `{{SERVICE_USER}}` (no sudo, no inbound SSH, lingering, rootless podman). Runs OpenClaw as `{{DEVELOPER_NAME}}`, the delegated coding agent, `alcode`, `alproject`, and the managed projects under `{{PROJECTS_ROOT}}`.
- **Public IP:** deployment-specific, written `<vps-ip>` throughout the docs. Never substitute it from a guess.

## Request flow

```text
channel message ({{DEVELOPER_NAME}} on the selected surface)
  → OpenClaw gateway (systemd --user unit, loopback :18789)
  → workspace AGENTS.md → alignfirst-developer-openclaw-playbook (thread routing, working session)
  → alproject (project inventory, canonical paths, ports)
  → alcode (delegation) → coding agent
  → project workspace under {{PROJECTS_ROOT}}
```

The runtime model and the coding agent are independent choices: OpenClaw authenticates its provider, `alcode` starts the agent selected by `ALIGNFIRST_CODE_AGENT`.

## Ownership

- This repository, in the admin account, describes the deployment. The service account never reads it; it works from the snapshot `~{{SERVICE_USER}}/seed/`, refreshed by the operator with `rsync` ([04 § 2](installations/04-openclaw.md#2-snapshot)).
- `~{{SERVICE_USER}}/.openclaw/`: `openclaw.json` (written by the seed through `openclaw config set`), `workspace/` (applied from the snapshot), `secrets/secrets.json` (every credential, referenced from `openclaw.json` as file SecretRefs), `.env` (the gateway env file, `CONTEXT7_API_KEY` only).
- The gateway unit is written by `openclaw gateway install`; the environment comes from `~/.config/environment.d/`, installed by the seed.
- Configuration, workspace files, skills, the coding agent's instructions and the npm prefix are immutable once [06](installations/06-security-hardening.md) has run.

## Firewall

Default deny incoming, allow outgoing. The OpenClaw gateway binds to loopback and is reached through an SSH tunnel; the channel connection is outbound.

| Port | Purpose |
| --- | --- |
| 22/tcp | SSH |
<!-- DEV_SERVER_GATEWAY_SECTION -->
| 80/tcp | HTTP to HTTPS redirect (Caddy) |
| 443/tcp | Dev-server gateway (Caddy + Authelia), `*.{{DEV_DOMAIN}}` |
<!-- DEV_SERVER_GATEWAY_SECTION -->

The dev-server range `{{PORT_RANGE_FIRST}}–{{PORT_RANGE_LAST}}` is closed.

## Projects

`alproject` is the inventory; this repository keeps no project list.

```sh
sudo -i -u {{SERVICE_USER}} -- alproject list
sudo -i -u {{SERVICE_USER}} -- alproject status <repo>
```

Adding one: [add-project.md](operations/add-project.md).

## Where to write new commands

Append the commands and a short explanation to the most relevant runbook under `installations/`, or create a topic file there when none fits, so the setup replays on a fresh server. Style: one line of prose, then a fenced code block.

Behaviors that look wrong and are intentional: [gotchas.md](gotchas.md).
