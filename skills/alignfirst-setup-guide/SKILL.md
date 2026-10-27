---
name: alignfirst-setup-guide
description: >-
  Install, upgrade, recommend, or combine AlignFirst protocols, skills, Docmap and multi-stack workspaces; prepare projects through repository or companion files; set up AlignDev for an OpenClaw assistant or a coding-agent assistant.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.54.0"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Setup Guide

Route by the user's intent. Inspect the repository and load the relevant references before changes. Protocols, skills, Docmap and workspaces can each be adopted independently. Require a clean working tree immediately before project mutations; read-only discovery needs no clean-tree gate.

## Named tool

Install or upgrade only what the user requested. Do not add unrelated tools or present the full menu.

- **CLI, protocols or skills:** [alignfirst-skills-setup.md](references/alignfirst-skills-setup.md). Skills invoke the CLI without a separate installation. Existing v1/v2/v3 skills or old home layouts first use [alignfirst-upgrade.md](references/alignfirst-upgrade.md).
- **Work-files repository:** [plans-setup.md](references/plans-setup.md).
- **Docmap:** [docmap-setup.md](references/docmap-setup.md). For docs adoption, follow its bootstrapping/migration references when relevant.
- **Workspace, any stack:** [workspace-setup.md](references/workspace-setup.md). Node, Python, Rust and monorepos use the same `alignfirst workspace`/`alignfirst dev` CLI. No project wrapper or local kernel dependency is needed. Never recommend reimplementing the kernel for another language.
- **Retired `.alignfirst.json`, workspace wrappers or old runtime registries:** [clean-break upgrade runbook](../../docs/upgrading-multi-stack-workspaces.md). Account for all resources and worktrees before conversion.
- **AlignDev:** ask whether it serves an OpenClaw assistant or a coding agent. OpenClaw uses [aligndev-openclaw.md](references/aligndev-openclaw.md); a coding-agent assistant uses [coding-agent-assistant.md](references/coding-agent-assistant.md).

## Tooling recommendation

When asked what to adopt, inspect repository evidence and available skills. Present global skills separately from project tooling. Let the user choose any subset before installation.

Global choices are `aligndev` (assistant playbook), `alignfirst` (protocol recognition), `paseo-alignfirst-workspace` (Paseo lifecycle), and command shortcuts `alspec`, `alplan`, `al`, `almerge`, `alreview`, `aldescription`, `alcatchup`, `alcatchupaad`, `alcatchupspec`. Command skills retain `disable-model-invocation: true`. Humans use `/name` in Claude/Copilot/Cursor, `$name` in Codex and `/skill:name` in Pi. The protocol-recognition skill is unnecessary when canonical project context instructions already supply it.

A missing name in the session's skill list means unavailable here, not absent on disk. If the host exposes no list, availability is unknown. This check needs no filesystem scan or installer. Install globally only with approval, using the selected reference's current command. A skill alone supplies no executable Pi tools. Preserve duplicate-tool audits and native trust/permission policies. For Paseo, read its skill before creating/removing actual workspaces and preserve archive-before-removal.

Recommend protocols and Docmap regardless of language. Workspace isolation is also language-neutral; preserve existing project commands by expressing them in the selected configuration's workspace recipe. An absent manifest supplies protocol-ready defaults. Detect existing tooling and propose conversion rather than running incompatible old wrappers against new registries. Determine whether a separate work-files repository already exists before offering one.

## Project instructions

- Protocol adoption uses the canonical `alignfirst context` bootstrap from [skills setup](references/alignfirst-skills-setup.md#project-instructions), replacing redundant Docmap discovery prose while preserving essential-documentation lists and project-specific rules.
- Docmap-only adoption uses its own discovery snippet.
- Workspace-only adoption uses [workspace instructions](references/workspace-setup.md#agent-instructions).

Global skills do not opt every repository into protocols. Workspace and Docmap adoption alone do not opt it into protocols either.

## A repository that must stay untouched

Use [companion-setup.md](references/companion-setup.md). Protocols and Docmap can keep all selected files outside the repository. A registration's `defaultLocation: "companion"` can also select the complete recipe and external runtime. This creates no checkout runtime directory/link or runtime ignore rule. Placement is not a write sandbox: project commands, shared directories, application outputs and Git operations retain their writes. Obtain approval for those effects.

## Prepare a project for an assistant

An assistant coordinates the conversation and delegates coding to the coding **agent** through AlignDev. Prepare these facts before normal ticket/coding effects:

1. Canonical context bootstrap as the first `##` section of `AGENTS.md` or `CLAUDE.md`, after title/introduction. `alignfirst.json` or `alignfirst.jsonc` with `schemaVersion: 1` is required for an assistant-managed project and optional otherwise. Companion-only projects place selected instructions/settings outside the repository.
2. Usable effective plans, untracked by the product repository. A separate work-files repository may track them. Use the separately authorized `aligndev guide work-files-setup` for missing/project-tracked plans, before ticket reservation, request capture or coding effects. Preserve old history without unsolicited copying.
3. Docmap and meaningful project docs. When `docs/` is absent and documentation is part of preparation, follow [docmap-bootstrapping.md](references/docmap-bootstrapping.md).
4. A unified workspace route through `alignfirst workspace`. The optional recipe in the selected merged configuration declares project commands; without `workspace`/`devServer`, setup is protocol-ready and performs no install/build/start. Prepare effective plans and selected runtime storage first; only project runtime requires ignored/untracked `.local-wt/`. Document separate stack commands when defaults are used.
5. Confirmed runtime requirements. Node projects declare their version through `.nvmrc`, `.node-version` or `engines.node`; ask when none exists. Python and other runtimes retain their documented tools. Running the CLI through Node/Bun does not change project commands.
6. A project-specific developer guide, commonly `DEVELOPERS.md` or `README.md`, with its relative path explicitly recorded as `developerInstructions`. Use `alignfirst developer-instructions` to read conventions and configured content, and nullable `locations.developerInstructions` to locate edits. Without a reference there is no filename fallback. Include confirmed commands, architecture, documentation map, workflow and verification. Include the workspace guide pointer and its actual readiness boundary, public URLs when services exist, and external ownership rules.
7. `aligndev project doctor --root <projects-directory>` passes after settings/manifest creation and before workspace setup. A range belongs solely in `devServer.ports`; use `project free-ports` as a lookup when the inventory owns an enclosing range.

Assistant preparation skips command-skill installation and global bootstrap changes unless separately requested. Companion-only preparation follows its authorization and location checks. Native coding-agent permissions are unchanged; report protected-path refusals rather than bypassing them.

## Create or operate an OpenClaw assistant

Read [aligndev-openclaw.md](references/aligndev-openclaw.md), including its deployment gate, before rendering/upgrading. The generated private admin repository owns installation/operations runbooks. Do not load deployment procedures for ordinary project tooling.

The three overlays use named profiles and inventoried native stores. Pi retains its approved writable `auth.json` exception; other managed resources remain maintenance-protected. Offline template checks do not certify deployment, OS hardening, authentication or conversation behavior. Do not perform live/admin operations without separate authorization.

## A coding agent as the assistant

For Claude Code, Codex or a persistent Pi session on one project, read [coding-agent-assistant.md](references/coding-agent-assistant.md). Pi uses `/skill:aligndev` and separately installed executable capabilities; installing a skill alone provides none. OpenClaw remains the persistent parent for its deployment route.

## Investigation rules

Detect the package manager from `packageManager`, then root lockfiles, falling back to npm. Translate application commands to the confirmed toolchain. CLI forms remain `npx -y alignfirst` for Node and `bunx --bun alignfirst` for explicit Bun; project scripts are optional conveniences.

Detect protocols through context/bootstrap/configuration, work files through effective `.plans`/`plans.repositoryFolder`, Docmap through commands/docs, and workspaces through manifests, commands or documented old tooling. Legacy package scopes and wrappers are upgrade evidence, not instructions to preserve the old kernel. Consult the runbook before changing formats or retiring state. No global installation, live registry mutation or external repository edit is implied by recommendation or rendering.
