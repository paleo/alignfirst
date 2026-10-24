---
title: Overview
read_when:
  - starting any task in this repository
  - tracing a request from the channel or an app to a project
---

# Overview

## Identity

- **Host:** `{{SERVER_HOST}}`, Ubuntu 24.04, time zone `{{TIME_ZONE}}`.
- **Admin account:** `{{SERVER_ADMIN_USER}}` (sudo, key-only SSH). Holds this repository at `~/{{ADMIN_REPOSITORY_NAME}}`.
- **Service account:** `{{SERVICE_USER}}` (no sudo, no inbound SSH, lingering, rootless podman). Runs OpenClaw as `{{ASSISTANT_NAME}}` on system Node 26 through `/opt/{{SERVICE_USER}}/bin/openclaw`; project work uses fnm. Runs the delegated coding agent, `alignfirst`, `aligndev`, and the managed projects under `~/projects`.
- **Public IP:** deployment-specific, written `<vps-ip>` throughout the docs. Never substitute it from a guess.

## Request flow

```text
channel message ({{ASSISTANT_NAME}} on the selected surface)
  → OpenClaw gateway (systemd --user unit, loopback :18789)
  → playbook (aligndev guide) channel triage → native starter → durable handoff → regular thread turn
  → regular thread session claims startup
  → aligndev project (project inventory, canonical paths, ports)
  → aligndev code (delegation) → coding agent
  → project workspace under ~/projects
```

An app conversation needs no triage or handoff ([use-the-apps.md](operations/use-the-apps.md)):

```text
app conversation (web, desktop or mobile app, through Tailscale Serve)
  → OpenClaw gateway (same unit)
  → playbook (aligndev guide) → aligndev guide --channel app working-session
  → aligndev project (project inventory, canonical paths, ports)
  → aligndev code (delegation) → coding agent
  → report in the same conversation
```

The runtime model and the coding agent are independent choices: OpenClaw authenticates its provider, `aligndev code` starts the agent in the selected named profile. `code.profile` is the deployment default; an explicit override or project registry selection takes precedence. Every provisioned coding/quota store pins `configDir: null` for native-default routing or an explicit service-account directory string. The shared inventory covers default/custom directories and deduplicates shared stores ([configuration.md](configuration.md)). Every provisioned account is available to the service UID; the editable project registry is routing, not authorization. OpenClaw remains the persistent parent even with a Pi child and needs no `pi-background` for delegation.

## Ownership

- This repository, in the admin account, describes the deployment. The service account never reads it; it works from the snapshot `~{{SERVICE_USER}}/seed/`, refreshed by the operator with `rsync` ([04 § 2](installations/04-openclaw.md#2-snapshot)).
- `~{{SERVICE_USER}}/.openclaw/`: `openclaw.json` (written by the seed through `openclaw config set`), `workspace/` (applied from the snapshot), `secrets/secrets.json` (every credential, referenced from `openclaw.json` as file SecretRefs), `.env` (the gateway env file, `CONTEXT7_API_KEY` only), and `thread-handoff/state.sqlite` (the plugin's durable handoff state).
- The gateway unit is written by `openclaw gateway install`; the environment comes from `~/.config/environment.d/`, installed by the seed.
- `~{{SERVICE_USER}}/.alignfirst/aligndev.settings.json` holds the aligndev settings, installed by the seed. The seed also creates `companions/`, where the projects' companion directories and their registry live. The assistant registers a project there with `alignfirst companion register`.
- `/opt/{{SERVICE_USER}}/` holds root-owned launchers, runtime files and the paired `deployment-profiles.mjs` / `deployment-policy.mjs` helpers for maintenance and backup. Pi's launcher verifies its pinned package entry point and executes `/usr/bin/node` without changing project PATH; packaged subagents reuse `process.execPath`. The gateway's persistent PATH and shell drop-in is service-owned.
- Configuration, workspace files, skills, managed native instructions/resources and the npm prefix are protected once [06](installations/06-security-hardening.md) has run. The policy makes native roots and ancestors root-owned sticky writable anchors rather than freezing whole Pi stores. Pi's sole approved executable-declaration exception is private, service-owned and replaceable `<agent-dir>/auth.json`, including adjacent locks for OAuth renewal. Same-UID processes can persist executable API-key commands there; this is account-level persistence, not administrator escalation.
- Pi project discovery inherits manually saved trust from an approved project/worktree parent. The nearest saved decision wins; trust is not a sandbox. Backups include all native stores and external resources with original-destination and executable-mode mappings.

## Firewall

Default deny incoming, allow outgoing. The OpenClaw gateway binds to loopback. The operator reaches it through an SSH tunnel, the team's apps through Tailscale Serve; the channel connection is outbound.

| Port | Purpose |
| --- | --- |
| 22/tcp | SSH |
<!-- DEV_SERVER_GATEWAY_SECTION -->
| 80/tcp | HTTP to HTTPS redirect (Caddy) |
| 443/tcp | Dev-server gateway (Caddy + Authelia), `*.{{DEV_DOMAIN}}` |
<!-- DEV_SERVER_GATEWAY_SECTION -->

The dev-server range `{{PORT_RANGE_FIRST}}–{{PORT_RANGE_LAST}}` is closed.

## Projects

`aligndev project` discovers projects from `.alignfirst.json`; this repository keeps no project list.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project list'
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project status ~/projects/<repo>'
```

Adding one: [add-project.md](operations/add-project.md).

## Where to write new commands

Append the commands and a short explanation to the most relevant runbook under `installations/`, or create a topic file there when none fits, so the setup replays on a fresh server. Style: one line of prose, then a fenced code block.

Behaviors that look wrong and are intentional: [gotchas.md](gotchas.md).
