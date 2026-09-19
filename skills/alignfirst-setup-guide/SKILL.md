---
name: alignfirst-setup-guide
description: >-
  Install, upgrade, recommend, or combine the AlignFirst CLI, skills, docmap, and workspace in a
  consumer repository, or prepare a repository and Linux deployment for the AlignFirst Dev Kit.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.39.1"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Setup Guide

Route by the user's intent. Load only the references needed for that route. Docmap, workspace, and the AlignFirst skills can each be adopted independently.

## Terminology

The **AlignFirst CLI** is the `alignfirst` npm package and bin. It provides `guide`, `ticket`, `sync`,
`plans`, `docmap`, `conventions`, `context`, `config`, and `doctor`.

The **AlignFirst skills** are stubs that run the CLI. The nine command skills `alspec`, `alplan`,
`al`, `almerge`, `alreview`, `aldescription`, `alcatchup`, `alcatchupaad`, and `alcatchupspec` keep
`disable-model-invocation: true`; humans invoke them as `/alspec` in Claude Code, GitHub Copilot,
Cursor, or `$alspec` in Codex. The optional `alignfirst` skill lets the agent recognize a protocol
named in prose; a project whose instruction file starts with the canonical `alignfirst context`
section provides this itself.

`alignfirst-setup-guide` and `alignfirst-openclaw-playbook` are separate skills. A
work-files repository is an optional CLI mode configured through `alignfirst plans setup`.

A claw host also installs `@alignfirst/alcode`, the companion CLI for coding-agent
delegation and project discovery.

## Named Tool

When the user names a tool, inspect the repository and proceed directly to that tool. Install or
upgrade only what they requested.

- **AlignFirst CLI, protocols, or skills**: [alignfirst-skills-setup.md](references/alignfirst-skills-setup.md). Install only the requested components; skills invoke the CLI through `npx` without a separate installation.
  For an existing v1, v2, or v3 installation, start with
  [alignfirst-upgrade.md](references/alignfirst-upgrade.md).
- **Work-files repository**: [plans-setup.md](references/plans-setup.md).
- **docmap**: [docmap-setup.md](references/docmap-setup.md).
- **workspace**: [workspace-setup.md](references/workspace-setup.md).

Do not present the tooling menu or add unrelated tools on this route.

## Tooling Recommendation

When the user asks what the project could adopt, inspect the repository and present these independent
choices:

- **AlignFirst protocols** provide collaborative specification, planning, implementation, merge, review, description, and catch-up workflows through the CLI. Command skills add shortcuts and can be installed on their own. A work-files repository is an optional sub-choice.
- **docmap** makes the repository's `docs/` tree discoverable to agents and humans. It is available
  through the AlignFirst CLI or as the standalone `@alignfirst/docmap` package.
- **workspace** creates isolated git-worktree development environments.

Determine whether a work-files repository exists before offering that option. Let the user choose
any subset.

## Project Instructions

Choose the `AGENTS.md` or `CLAUDE.md` discovery section from the project's adopted tools:

- **AlignFirst skills or protocols:** use the `alignfirst context` section from [AlignFirst setup](references/alignfirst-skills-setup.md#project-instructions). It replaces `Docmap - Seek Documentation`; preserve any essential-documentation list and project-specific instructions.
- **Docmap without AlignFirst skills or protocols:** use `Docmap - Seek Documentation` from [Docmap setup](references/docmap-setup.md#agent-instructions), with the project's actual Docmap command.
- **Workspace only:** add the [workspace instructions](references/workspace-setup.md#agent-instructions).

Installing Docmap or workspace alone does not opt the project into AlignFirst protocols. Installing skills globally does not opt every repository into them.

## AlignFirst Dev Kit for OpenClaw

The **Dev Kit** deploys a persistent AI teammate for software work. That teammate receives requests
through team chat, manages each task in an isolated project workspace, and delegates repository work
to a coding **agent** (Claude Code or Codex) using the AlignFirst protocols.

One deployment is a **claw**: a dedicated Linux service account running OpenClaw under its own name
and channel identity, on Slack or Discord. These three terms are used throughout this skill and the
repositories it renders.

Preparing a project makes its repository compatible with a claw. Creating a claw builds and deploys
the teammate itself.

## Prepare a Project for a Claw

Inspect the repository before changing it. A prepared project has all of these:

1. The canonical bootstrap section in `AGENTS.md` or `CLAUDE.md`, placed before every other section
   whenever possible. The README may offer a global AlignFirst CLI installation as a convenience.
   `.alignfirst.json` is required for a claw-managed project and optional otherwise.
2. A clean `alproject doctor --root <projects-directory>` result after writing
   `.alignfirst.json` and before workspace setup. Stop preparation when the inventory is unhealthy.
3. The work-files repository through `alignfirst plans setup` when the team has one.
4. docmap, including project scripts or CLI instructions. When the repository has no `docs/`
   directory, bootstrap its documentation through
   [docmap-bootstrapping.md](references/docmap-bootstrapping.md) as part of the preparation.
5. workspace, adapted to the project's runtime and development lifecycle, meeting
   [the Dev Kit contract](references/workspace-setup.md#the-dev-kit-contract).
6. A Node version declaration (`.nvmrc`, `.node-version` or `engines.node`) so fnm selects the project runtime. Ask which version to declare when the repository has none.
7. A project-specific `DEVELOPERS.md` for an unfamiliar developer: commands, architecture,
   documentation map, development workflow, and verification procedures.

Detect and verify the package manager, runtime, build, test, lint, dev-server, ports, shared
directories, seeded configuration files, and team-plan details. Write only facts confirmed from the
repository. Follow each selected tool reference above, then complete `DEVELOPERS.md`, naming the Node version declaration.

## Create a Claw

For creating or operating the claw deployment itself, read
[alignfirst-dev-kit.md](references/alignfirst-dev-kit.md). Do not load that workflow for ordinary
tool setup.

## Shared Investigation Rules

Detect the package manager from `packageManager` in `package.json`, then the root lockfile:
`package-lock.json` means npm, `pnpm-lock.yaml` means pnpm, `yarn.lock` means yarn, and `bun.lock` or
`bun.lockb` means bun. Fall back to npm.

Translate commands to that package manager. npm needs `--` before script flags; pnpm and yarn omit
`run` and the separator; bun keeps `run` but omits the separator.

Detect existing footprints before proposing changes:

- docmap: a `docmap` script, `@alignfirst/docmap`, `alignfirst docmap` in an instruction file, or `docs/`.
- workspace: a `workspace` script or `@alignfirst/workspace`.
- A pre-`@alignfirst` install: `@paleo/docmap` or `@paleo/workspace` in the manifest. Move the
  dependency to the `@alignfirst` name before proposing anything else; the two scopes install side
  by side and the wrapper keeps importing the old one.
- AlignFirst: `.alignfirst.json`, `.plans/`, a bootstrap section running `alignfirst context` or
  `npx alignfirst context`, an AlignFirst instruction section, or a canonical skill installation.
- work-files repository: a `.plans` symlink or `plans.folder` in `.alignfirst.json`.
- Claw preparation: the complete seven-part contract above.

Require a clean working tree immediately before project mutations. Read-only discovery and
recommendations do not require one.

## Temporary Local Installation

When this guide was installed only for the current project, remove it through the skills CLI after
setup:

```sh
npx -y skills remove alignfirst-setup-guide --yes </dev/null
```

The CLI owns `skills-lock.json`. Leave global installations in place for other repositories. A
claw service account must retain a global installation for its delegated coding agent.
