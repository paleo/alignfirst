---
name: alignfirst-setup-guide
description: >-
  Install, upgrade, recommend, or combine the AlignFirst CLI, skills, docmap, and workspace in a
  consumer repository, or prepare a repository and Linux deployment for an AlignFirst Developer.
compatibility: Requires git and a Node.js package manager (npm, pnpm, yarn, or bun).
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.34.0"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Setup Guide

Route by the user's intent. Load only the references needed for that route.

## Terminology

The **AlignFirst CLI** is the `alignfirst` npm package and bin. It provides `guide`, `ticket`, `sync`,
`plans`, `docmap`, `conventions`, `context`, `config`, and `doctor`.

The **AlignFirst skills** are eight stubs that run the CLI: `alignfirst`, `alspec`, `alplan`, `al`,
`almerge`, `alreview`, `aldescription`, and `alcatchup`. The seven command skills keep
`disable-model-invocation: true`; humans invoke them as `/alspec` in Claude Code, GitHub Copilot,
Cursor, or `$alspec` in Codex.

`alignfirst-setup-guide` and `alignfirst-developer-openclaw-playbook` are separate skills. A team
plans repository is an optional CLI mode configured through `alignfirst plans setup`.

An AlignFirst Developer host also installs `@paleo/alcode`, the companion CLI for coding-agent
delegation and project discovery.

## Named Tool

When the user names a tool, inspect the repository and proceed directly to that tool. Install or
upgrade only what they requested.

- **AlignFirst CLI and skills**: [alignfirst-skills-setup.md](references/alignfirst-skills-setup.md).
  For an existing v1, v2, or v3 installation, start with
  [alignfirst-upgrade.md](references/alignfirst-upgrade.md).
- **Team plans repository**: [plans-setup.md](references/plans-setup.md).
- **docmap**: [docmap-setup.md](references/docmap-setup.md).
- **workspace**: [workspace-setup.md](references/workspace-setup.md).

Do not present the tooling menu or add unrelated tools on this route.

## Tooling Recommendation

When the user asks what the project could adopt, inspect the repository and present these independent
choices:

- **AlignFirst** installs the CLI and the eight skills for collaborative specification, planning,
  implementation, merge, review, description, and catch-up workflows. A team plans repository is an
  optional sub-choice.
- **docmap** makes the repository's `docs/` tree discoverable to agents and humans. It is available
  through the AlignFirst CLI or as the standalone `@paleo/docmap` package.
- **workspace** creates isolated git-worktree development environments.

Determine whether a team plans repository exists before offering that option. Let the user choose
any subset.

## AlignFirst Developer

An AlignFirst Developer is a persistent AI teammate for software work. It receives requests through
team chat, manages each task in an isolated project workspace, and delegates repository work to
a coding agent (Claude Code or Codex) using the AlignFirst protocols. The current deployment runs on
OpenClaw through Slack or Discord under a dedicated Linux service account.

Preparing a project makes its repository compatible with an AlignFirst Developer. Creating an
AlignFirst Developer builds and deploys the teammate itself.

## Prepare a Project for an AlignFirst Developer

Inspect the repository before changing it. A prepared project has all of these:

1. The AlignFirst CLI as a prerequisite in `README.md`, the eight skills, and a bootstrap line in
   `AGENTS.md` or `CLAUDE.md`. `.alignfirst.json` is required for an AlignFirst Developer project and
   optional otherwise.
2. A clean `alproject doctor --root <projects-directory>` result after writing
   `.alignfirst.json` and before workspace setup. Stop preparation when the inventory is unhealthy.
3. The team plans repository through `alignfirst plans setup` when the team has one.
4. docmap, including project scripts or CLI instructions. When the repository has no `docs/`
   directory, bootstrap its documentation through
   [docmap-bootstrapping.md](references/docmap-bootstrapping.md) as part of the preparation.
5. workspace, adapted to the project's runtime and development lifecycle, meeting
   [the AlignFirst Developer contract](references/workspace-setup.md#the-alignfirst-developer-contract).
6. A project-specific `DEVELOPERS.md` for an unfamiliar developer: commands, architecture,
   documentation map, development workflow, and verification procedures.

Detect and verify the package manager, runtime, build, test, lint, dev-server, ports, shared
directories, seeded configuration files, and team-plan details. Write only facts confirmed from the
repository. Follow each selected tool reference above, then complete `DEVELOPERS.md`.

## Create an AlignFirst Developer

For creating or operating the developer deployment itself, read
[alignfirst-developer.md](references/alignfirst-developer.md). Do not load that workflow for ordinary
tool setup.

## Shared Investigation Rules

Detect the package manager from `packageManager` in `package.json`, then the root lockfile:
`package-lock.json` means npm, `pnpm-lock.yaml` means pnpm, `yarn.lock` means yarn, and `bun.lock` or
`bun.lockb` means bun. Fall back to npm.

Translate commands to that package manager. npm needs `--` before script flags; pnpm and yarn omit
`run` and the separator; bun keeps `run` but omits the separator.

Detect existing footprints before proposing changes:

- docmap: a `docmap` script, `@paleo/docmap`, `alignfirst docmap` in an instruction file, or `docs/`.
- workspace: a `workspace` script or `@paleo/workspace`.
- AlignFirst: `.alignfirst.json`, an AlignFirst CLI prerequisite in `README.md`, `.plans/`, a
  bootstrap line running `alignfirst conventions` or `alignfirst context`, an AlignFirst instruction
  section, or a canonical skill installation.
- team plans: a `.plans` symlink or `plans.folder` in `.alignfirst.json`.
- AlignFirst Developer preparation: the complete five-part contract above.

Require a clean working tree immediately before project mutations. Read-only discovery and
recommendations do not require one.

## Temporary Local Installation

When this guide was installed only for the current project, remove it through the skills CLI after
setup:

```sh
npx -y skills remove alignfirst-setup-guide --yes </dev/null
```

The CLI owns `skills-lock.json`. Leave global installations in place for other repositories. An
AlignFirst Developer service account must retain a global installation for its delegated coding agent.
