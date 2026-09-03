# {{ADMIN_REPOSITORY_NAME}}

Private repository that reproduces and operates **{{DEVELOPER_NAME}}**, the AlignFirst Developer of {{TEAM_NAME}}, on `{{SERVER_HOST}}`. Runbooks under [`docs/`](docs/) (`alignfirst docmap` to browse); the OpenClaw seed, workspace files and scripts under [`infra/openclaw/`](infra/openclaw/).

## Bootstrap order

- [01-server-setup.md](docs/installations/01-server-setup.md) — human, on the fresh server
- [02-admin-repository.md](docs/installations/02-admin-repository.md) — operator, from here on
- [03-toolchain.md](docs/installations/03-toolchain.md)
- [05-openclaw-dependencies.md](docs/installations/05-openclaw-dependencies.md)
- [07-channel.md](docs/installations/07-channel.md) — platform part
- [04-openclaw.md](docs/installations/04-openclaw.md)
- [08-coding-agent.md](docs/installations/08-coding-agent.md)
<!-- DEV_SERVER_GATEWAY_SECTION -->
- [09-dev-server-gateway.md](docs/installations/09-dev-server-gateway.md)
<!-- DEV_SERVER_GATEWAY_SECTION -->
- [06-security-hardening.md](docs/installations/06-security-hardening.md) — last: it locks what the others write
- [07-channel.md](docs/installations/07-channel.md) — smoke test

Then [`docs/operations/`](docs/operations/), starting with [add-project.md](docs/operations/add-project.md).

## Fresh clone

In the admin account:

```sh
npm install -g alignfirst
npm install
# TEAM_PLANS_SECTION
alignfirst plans setup <plans-clone-path>
# TEAM_PLANS_SECTION
mkdir -p .plans .local
npm run workspace -- setup
alignfirst docmap
```

Optional upstream reference for investigations (host-only, gitignored):

```sh
git clone --depth=1 https://github.com/openclaw/openclaw.git .local/openclaw
```
