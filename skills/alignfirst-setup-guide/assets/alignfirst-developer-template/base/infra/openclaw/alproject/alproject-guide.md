# Managed Project Rules

Use `alproject list --json` as the project inventory. A managed project is a canonical main Git
worktree directly beneath an allowed project parent.

Before registration, prepare the repository through `alignfirst-setup-guide`: AlignFirst skills,
conditional plans-share, docmap, workspace, and a project-specific `DEVELOPERS.md` are required. Run
the project's workspace main-worktree setup and verification before `alproject register`.

Port allocation is optional. Reserve ports only for a project whose workspace wrapper uses them.
Missing-path and unregistered statuses are diagnostic; never edit `alproject-registry.json` directly.
Restore a valid registry backup or correct `.alproject.json`, then use `alproject register` or
`unregister` to change owned state.
