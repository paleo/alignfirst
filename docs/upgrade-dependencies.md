---
title: Upgrading Dependencies
summary: Upgrade workspace and harness dependencies, related pins and local coding tools.
read_when:
  - upgrading or updating dependencies
  - updating the local Codex CLI or Node 26 runtime
---

# Upgrading Dependencies

## Start from a clean baseline

Refuse to start a bulk upgrade when `git status --short` reports changes. Finish or checkpoint existing work with the developer's approval first. Record the starting commit and relevant baseline failures. Resolve unrelated failures separately before changing dependency versions.

Read the `sharp-testing`, `top-down-typescript` and `sharp-writing` skills. Read [Upgrading OpenClaw](aligndev-openclaw/upgrading-openclaw.md) for host/plugin changes and [Pi Extensions](pi-extensions.md) for Pi changes. Consult upstream migration guides when APIs or defaults change.

## Inventory every dependency surface

The root npm workspace covers `packages/*`, but not every dependency in this repository:

- Root and workspace manifests share `package-lock.json`.
- `aligndev-openclaw-tests/` has its own manifest and lockfile. Its `file:vendor/*.tgz` dependencies must remain local tarballs rebuilt from this checkout.
- `aligndev-openclaw-tests/projects-fixture/template/` has an application manifest and `pnpm-lock.yaml`.
- Dockerfiles, CI and disposable-install scripts can carry reproducibility pins. Deployment guides install current stable tools and derive runtime requirements from installed metadata; review their compatibility without adding release pins. Distinguish executable pins from historical acceptance records.

Use the npm `latest` tag, excluding prereleases. Keep a shared dependency on the same version in every consumer. Preserve existing exact or range conventions unless a compatibility requirement dictates otherwise. Keep internal workspace dependencies aligned with the local package versions; do not replace them with newer registry packages or bump this repository's package versions manually.

## Refresh manifests and lockfiles

Preview updates before applying them. For the root and workspaces:

```sh
npx --yes npm-check-updates --workspaces --root --dep prod,dev,optional
npx --yes npm-check-updates --workspaces --root --dep prod,dev,optional -u
```

Inspect the result before installing. Restore internal dependency references and compatibility-constrained versions before resolution. Review peer dependencies separately; the commands above do not update them.

Run the same manifest review separately in the standalone harness and fixture directory. Keep vendored references unchanged. Rebuild the harness tarballs with `npm run vendor --prefix aligndev-openclaw-tests` before refreshing its installation; this builds and packs local packages without starting Docker. Update the fixture lockfile with its pinned pnpm version.

Use the reviewed npm CLI and local invocation in [Releasing](releasing.md#flow) under the repository's Node runtime. Run `npm install` at the root and `npm install --prefix aligndev-openclaw-tests` with that CLI.

Retain lockfiles and let the package manager update them. Avoid blanket `npm audit fix --force`, overrides that conceal host incompatibilities, and recursive removal of `node_modules` or lockfiles. If a clean reinstall is necessary, identify the exact owned installation and preserve the lockfile first. Never remove scenario artifacts, gateway logs, shared runtime directories or another worktree's installation.

## Compatibility constraints

- Keep Node on major 26 and `@types/node` on 26.x. Upgrade the local Node 26 installation to its latest stable patch when requested or required by dependencies. Raise affected engine floors to actual dependency requirements; preserve independently supported runtime lines where possible.
- Keep npm and other `packageManager` pins unchanged unless the developer approves their upgrade. A runtime prerequisite is a decision to resolve, not a reason to silently choose an older dependency.
- Move all Pi development-package and disposable-test pins together. Preserve host-supplied `*` peers and avoid bundling duplicate Pi libraries. Deployment launchers derive the package entry and runtime requirements from installed metadata, without an approved-version argument. Read the installed Pi documentation and upstream changes before adapting SDK usage.
- OpenClaw, its official plugin installs and development-host pins move together in the harness. Follow the dedicated upgrade guide for schema, routing, transcript and deployment-default review; deployment guides remain unpinned.
- Match mock-core's exact Zod development and peer versions to the OpenClaw host's Zod version, even when standalone Zod is newer. Inspect `npm ls zod typebox --all`; do not force host-owned schema libraries to deduplicate across incompatible versions.
- Review the root and standalone `allowScripts` entries when their exact dependency versions change. Inspect upstream lifecycle scripts before approving a new version. Keep intentionally disabled scripts disabled.
- Reassess documented audit exceptions against the upgraded dependency tree. Record remaining advisories and their exact package paths. Do not patch files inside installed packages or suppress findings wholesale.

If an upgrade requires disproportionate changes, retain its previous version and record the blocker, affected surfaces and follow-up. Fix ordinary build/API incompatibilities rather than pinning around them. Discuss changes to product behavior, security policy or lint rules before implementation.

## Upgrade local tools

Check the executable and installation method before updating a global tool. Codex's standalone installation supports `codex update`; an npm-managed installation uses its package manager. Preserve configuration, credentials, sessions and existing installation ownership. Verify `codex --version` and inspect `codex debug models --bundled` afterward; model aliases depend on that bundled catalog.

Install the latest Node 26 release through the developer's existing version manager. Verify the actual executable and version used by subsequent commands. Avoid changing another Node major or the default interactive runtime without approval.

## Validate and report

Choose checks for the changed surfaces. Builds, typechecks, lint and ordinary unit suites are the baseline. Keep integration tests, packed-install smoke tests, Docker/gateway checks, native CLI acceptance and conversation-model scenarios separate. Run those only when authorized; a dependency upgrade does not override a developer's test restrictions. In particular, the standalone harness's complete `npm test` includes fixture integration, so choose pure helper test files when integrations are prohibited.

For allowed workspace checks:

```sh
npm run build
npm run typecheck
npm run lint
npm test
npx -y alignfirst docmap --check
git diff --check
```

Investigate failures before expanding validation. Never run the scenario matrix by default. Record unrun checks and acceptance gaps without relabeling historical results as validation of the new versions.

Review the final diff for accidental internal-package replacements, stale executable pins and unapproved lifecycle scripts. Add [changesets](writing-a-changeset.md) for affected published packages. Report upgraded versions, retained exceptions, audit findings, checks and local tool changes.
