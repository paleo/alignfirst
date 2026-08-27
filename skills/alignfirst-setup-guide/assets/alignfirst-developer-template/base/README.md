# {{DEVELOPER_NAME}} Administration

This private repository reproduces and operates the {{DEVELOPER_NAME}} AlignFirst Developer on
`{{SERVER_HOST}}`. The operator owns reviewed source files. The `{{SERVICE_USER}}` account owns the
deployed runtime and has no sudo access.

## Bootstrap Order

1. Complete [server setup](docs/installations/01-server-setup.md) as the privileged administrator.
2. Complete [admin repository setup](docs/installations/02-admin-repository.md) as the service user.
3. Complete [toolchain setup](docs/installations/03-toolchain.md).
4. Follow the remaining numbered documents under `docs/installations/`.
5. Run the verification checklist before enabling routine use.

Interactive authentication, secret creation, and secret entry are human actions. Keep secret values
outside git, chat, documentation, and shell history.

## Fresh Clone

From the repository root as the service user:

```sh
npm install
mkdir -p .plans .local
npm run workspace -- setup
npm run docmap
```

## Documentation

Run `npm run docmap` to list the operational documents. Start with
[the architecture overview](docs/overview.md). Installation is numbered; recurring work lives under
operations, recovery, and troubleshooting.

Do not place setup-once procedures in `AGENTS.md` or `DEVELOPERS.md`.
