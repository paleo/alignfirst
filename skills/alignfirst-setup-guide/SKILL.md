---
name: alignfirst-setup-guide
description: >-
  Install, upgrade, recommend, or combine AlignFirst skills, plans-share, docmap, and workspace in a
  consumer repository, or prepare a repository and Linux deployment for an AlignFirst Developer.
compatibility: Requires git and a Node.js package manager (npm, pnpm, yarn, or bun).
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.30.1"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Setup Guide

Route by the user's intent. Load only the references needed for that route.

## Terminology

AlignFirst is both the core `alignfirst` skill and the umbrella name for the related software
development tooling in this repository. In skill contexts, AlignFirst means the core skill, used
alone or with its command-alias companions. The core skill and any installed companions are the
**AlignFirst skills**. Use **AlignFirst tooling** for the broader product family when the
distinction matters.

The `alignfirst` skill contains the protocols. Its seven human-invoked command companions are
`alspec`, `alplan`, `al`, `almerge`, `alreview`, `aldescription`, and `alread`. The command skills
keep `disable-model-invocation: true`, humans invoke them as `/alspec` in Claude Code, GitHub
Copilot, Cursor, or `$alspec` in Codex.

`alignfirst-setup-guide` and `alignfirst-developer-openclaw-playbook` are separate skills.
plans-share is an optional companion to AlignFirst skills, not a fourth independent recommendation.

## Named Tool

When the user names a tool, inspect the repository and proceed directly to that tool. Install or
upgrade only what they requested.

- **AlignFirst skills**: [alignfirst-skills-setup.md](references/alignfirst-skills-setup.md). For an
  existing v1 or v2 installation, start with [alignfirst-upgrade.md](references/alignfirst-upgrade.md).
- **plans-share**: [plans-share-setup.md](references/plans-share-setup.md).
- **docmap**: [docmap-setup.md](references/docmap-setup.md).
- **workspace**: [workspace-setup.md](references/workspace-setup.md).

Do not present the tooling menu or add unrelated tools on this route.

## Tooling Recommendation

When the user asks what the project could adopt, inspect the repository and present these independent
choices:

- **AlignFirst skills** add collaborative specification, planning, implementation, merge, review,
  description, and task-reading commands. When the team has a plans repository, plans-share can back
  the project's `.plans` directory.
- **docmap** makes the repository's `docs/` tree discoverable to agents and humans.
- **workspace** creates isolated git-worktree development environments.

Determine whether a team plans repository exists before recommending plans-share. Let the user choose
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

1. AlignFirst skills and their project-specific `AGENTS.md` or `CLAUDE.md` section.
2. plans-share when a team plans repository exists.
3. docmap, including project scripts and agent instructions.
4. workspace, adapted to the project's runtime and development lifecycle, meeting
   [the AlignFirst Developer contract](references/workspace-setup.md#the-alignfirst-developer-contract).
5. A project-specific `DEVELOPERS.md` for an unfamiliar developer: commands, architecture,
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

- docmap: a `docmap` script, `@paleo/docmap`, or `docs/`.
- workspace: a `workspace` script or `@paleo/workspace`.
- AlignFirst skills: a canonical skill installation, `.plans/`, or an AlignFirst instruction section.
- plans-share: a plans-share script, dependency, or `.plans` symlink.
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
