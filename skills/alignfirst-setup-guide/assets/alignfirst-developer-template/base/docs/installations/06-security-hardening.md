---
title: Security Hardening
read_when:
  - applying or reviewing deployment protections
---

# Security Hardening

The service user has no sudo access. Rootless containers, a user-level service, restrictive secret
permissions, channel allowlists, and reviewed source files form the primary boundary.

> **Note:** Commands shown are for Ubuntu 24.04 with systemd. Adapt package, firewall, filesystem,
> and service-manager commands for another Linux server when needed.

## Administrator Controls

**Role: privileged server administrator.** Verify the account and host boundaries without entering
runtime secrets:

```sh
sudo -l -U '{{SERVICE_USER}}'
loginctl show-user '{{SERVICE_USER}}' -p Linger
sudo ufw status verbose
```

The service user must have no sudo grants. Keep inbound access restricted to reviewed administration
paths.

## Service-User Controls

**Role: service user.** Run after configuration and workspace application:

```sh
chmod 0700 "$HOME/.openclaw" "$HOME/.config/alignfirst-developer"
chmod 0600 "$HOME/.config/alignfirst-developer/environment"
openclaw config validate
openclaw secrets audit
systemd-analyze --user security openclaw-gateway.service
```

Review the systemd findings in context. Do not add protections that prevent the gateway from reading
its workspace, managed projects, or authenticated user-level CLI state.

## Protected Sources

Protect these independently after verification:

- effective runtime configuration and the secure environment;
- applied OpenClaw workspace files;
- installed OpenClaw and coding-agent skills;
- the selected coding agent's global instruction file;
- global npm packages and user service source.

Use ownership and read-only modes appropriate to the service user. Document the exact paths in the
generated repository. An update unprotects only its target, backs it up, applies and validates the
change, then restores the previous protection. Never use recursive ownership or mode changes against
the service user's home.

## Verification Boundary

Complete the selected channel and coding-agent runbooks before enabling the service for users. Test
negative channel access, secret audits, restart behavior, workspace dispatch, and the kill switch.
