---
title: OpenClaw Installation
read_when:
  - creating the OpenClaw baseline and user service
---

# OpenClaw Installation

**Role: service user.** Human runtime authentication and secret entry happen before configuration.
The OpenClaw runtime provider is `{{RUNTIME_PROVIDER}}`; the delegated coding agent is selected later
and may use another provider.

## Human Onboarding

Run the installed OpenClaw onboarding flow and authenticate the runtime provider interactively. Use
the installed CLI's `--help`; do not copy a command from another OpenClaw version. Select
`{{RUNTIME_MODEL}}`, a local workspace, and no public listener unless the deployment design requires
one.

Confirm the installed-version baseline before continuing:

```sh
openclaw --version
openclaw config --help
openclaw config validate
openclaw secrets --help
```

## Secure Environment

Create `infra/openclaw/secrets/environment` from `.env.example`. Enter secrets as a human in an editor
that does not record them in shell history. Set owner-only permissions:

```sh
install -d -m 0700 infra/openclaw/secrets
install -m 0600 infra/openclaw/.env.example infra/openclaw/secrets/environment
chmod 0600 infra/openclaw/secrets/environment
```

Replace every non-secret placeholder and enter the runtime and channel secret variables required by
the selected runbooks. Secret values remain in this untracked file. Generated OpenClaw configuration
uses env-backed SecretRefs.

## Source Configuration

```sh
install -m 0600 infra/openclaw/alproject/.alproject.json "$HOME/.alproject.json"
install -m 0600 infra/openclaw/alproject/alproject-guide.md '{{PROJECTS_ROOT}}/alproject-guide.md'
infra/openclaw/seed.sh
infra/openclaw/bin/apply-workspace.sh
```

The seed refuses incomplete overlays, invalid baseline configuration, missing values, or the wrong
service user before mutation. It validates effective configuration and SecretRefs after applying all
modules.

## User Service

> **Note:** Commands shown are for Ubuntu 24.04 with systemd. Adapt package, firewall, filesystem,
> and service-manager commands for another Linux server when needed.

```sh
install -d -m 0700 "$HOME/.config/systemd/user" "$HOME/.config/alignfirst-developer"
install -m 0600 infra/openclaw/secrets/environment \
  "$HOME/.config/alignfirst-developer/environment"
install -m 0644 infra/openclaw/systemd/openclaw-gateway.service \
  "$HOME/.config/systemd/user/openclaw-gateway.service"
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway.service
systemctl --user status openclaw-gateway.service
```

Validate configuration before every restart. Continue with
[OpenClaw dependencies](05-openclaw-dependencies.md).
