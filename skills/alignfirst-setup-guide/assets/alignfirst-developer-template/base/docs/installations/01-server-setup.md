---
title: Server Setup
read_when:
  - preparing a Linux host for the AlignFirst Developer
---

# Server Setup

**Role: privileged server administrator.** The human administrator runs every command in this
document. Stop if the live host conflicts with the collected deployment values.

The host must provide SSH administration, outbound access to required git and model providers,
rootless containers, a dedicated unprivileged `{{SERVICE_USER}}` account, and a user service manager.
The service account must not have sudo access.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and
> service-manager commands for another Linux server when needed.

## Inspect the Host

```sh
uname -a
cat /etc/os-release
timedatectl
ss -lntup
sudo ufw status verbose
```

Confirm the server is `{{SERVER_HOST}}`, the administrator is `{{SERVER_ADMIN_USER}}`, and the time
zone should be `{{TIME_ZONE}}` before changing anything.

## Base Packages and Network Policy

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq uidmap dbus-user-session podman slirp4netns fuse-overlayfs
sudo timedatectl set-timezone '{{TIME_ZONE}}'
```

Keep inbound access limited to the administrator's SSH path. OpenClaw uses outbound Socket Mode or
gateway connections and does not require a public listener unless a separately reviewed integration
does.

## Service Account

```sh
sudo adduser --disabled-password --gecos '' '{{SERVICE_USER}}'
sudo install -d -o '{{SERVICE_USER}}' -g '{{SERVICE_USER}}' -m 0700 '{{PROJECTS_ROOT}}'
sudo loginctl enable-linger '{{SERVICE_USER}}'
```

Do not add `{{SERVICE_USER}}` to sudo-capable groups. Configure an SSH path for human service-user
authentication according to the organization's access policy; never reuse the administrator's private
key.

## Rootless Container Check

Run as the service user through a login session:

```sh
podman info --format '{{.Host.Security.Rootless}}'
systemctl --user status
```

The first command must report `true`. The user service manager must be reachable after logout because
lingering is enabled.

## Handover

Give the operator the confirmed SSH host, service username, projects root, time zone, and any adapted
package or service-manager commands. Continue with
[admin repository setup](02-admin-repository.md).
