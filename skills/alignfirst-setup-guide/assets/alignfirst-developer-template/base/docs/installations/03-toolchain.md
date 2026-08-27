---
title: Toolchain Setup
read_when:
  - installing the service-user tools required by the deployment
---

# Toolchain Setup

**Role: service user**, except for the administrator package prerequisite below. Human authentication
steps are marked explicitly.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and
> service-manager commands for another Linux server when needed.

## Administrator Prerequisite

**Role: privileged server administrator.** Install Node 22.11 or newer through the organization's
approved repository or version manager. Confirm `node`, `npm`, `git`, `podman`, and `systemctl --user`
are available to `{{SERVICE_USER}}`.

## User-Level CLIs

**Role: service user.** Keep npm's global prefix in the service user's home when the system Node
installation does not already provide a writable user prefix.

```sh
npm config set prefix "$HOME/.local"
npm install --global @paleo/alcode@0.10.2 @paleo/alproject@1.1.0 openclaw
node --version
npm --version
podman --version
openclaw --version
alcode --help
alproject --guide
```

Install the official CLI for each selected git host named in `{{GIT_HOSTS}}`. When tooling expects a
Docker-compatible command, configure the rootless Podman compatibility layer for this service user;
do not add the user to a privileged Docker group.

## Human Authentication

The human service operator now authenticates:

1. Each selected git-host CLI or SSH key.
2. The OpenClaw runtime provider chosen as `{{RUNTIME_PROVIDER}}` with model
   `{{RUNTIME_MODEL}}`.
3. The delegated coding-agent CLI in the later selected-agent runbook.

Do not automate interactive login or copy credentials into repository files.

## Verify Rootless Operation

```sh
podman info --format '{{.Host.Security.Rootless}}'
podman run --rm docker.io/library/alpine:latest true
alproject list --json
```

Rootless mode must be true. The project list may be empty at this stage but must parse as JSON.
Continue with the next numbered installation document.
