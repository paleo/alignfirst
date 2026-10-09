# Set Up a Project Through Its Companion

Use this procedure for a repository that must stay untouched. Its AlignFirst files live in a **companion directory**: one directory per project, outside the repository, that reproduces the project's layout for AlignFirst files only. The companion registry, `~/.alignfirst/companions/registry.json`, declares which projects have one. `alignfirst` and `aligndev` read each item from the companion, so nothing is written in the repository.

The `alignfirst` package README documents the registry: its schema, how an entry matches a project, and how each item resolves.

This mode supports the AlignFirst protocols, the skills, the work files and docmap through the `alignfirst` CLI. It excludes the workspace system, the standalone `@alignfirst/docmap` package, a local `alignfirst` dependency, and any instruction-file section.

For a project prepared for an assistant, apply [For an Assistant](#for-an-assistant) to the steps below.

## 1. Install the CLI

```sh
npm install -g alignfirst
```

The global CLI is required: the agent bootstrap line runs the bare `alignfirst`. Install the skills through [Install the Skills](alignfirst-skills-setup.md#install-the-skills) when the user wants them. The `alignfirst` skill is unnecessary: `alignfirst context` prints the protocols.

## 2. Declare the companion

From the repository, register the project and read the layout:

```sh
alignfirst companion add
alignfirst config --json
```

`companion add` adds the project's main worktree to the registry, unless it is registered, and creates the companion directory when missing. The new entry leaves every item on `"auto"`: an item the repository already has stays in use, and a missing one goes to the companion. To set a flag, edit the entry in the registry, then read the layout again.

`companion.dir` is the companion directory, and `locations` gives each item's path.

Write each item below at its `locations` path. Skip an item located in the project (`"in": "project"`): the repository provides it.

## 3. Project config

Write `.alignfirst.json`, following [With `.alignfirst.json`](alignfirst-skills-setup.md#with-alignfirstjson). The `.gitignore` line does not apply.

## 4. Project instructions

Write `.alignfirst-instructions/context.md` when the project needs instructions beyond `.alignfirst.json`, such as an essential-documentation list. It holds the prose a prepared project keeps in its `AGENTS.md`, without the bootstrap section. `alignfirst context` prints it.

## 5. Docs

A `docs/` directory in the repository stays in use. Otherwise, bootstrap one at the companion path through [docmap-bootstrapping.md](docmap-bootstrapping.md) when the user wants project documentation. `alignfirst docmap` reads it there.

## 6. Work files

Create `.plans` in the companion. With a work-files repository, run `alignfirst plans setup <clone>` from the repository: it creates the link at the companion location. Otherwise:

```sh
mkdir -p <companion>/.plans
```

## 7. Agent bootstrap

An agent reads a repository's `AGENTS.md` on its own, never a companion. Add the [global bootstrap line](alignfirst-skills-setup.md#repositories-without-alignfirst-instructions) to the agent's global instruction file, after the user confirms. Skip it when the file already has it.

## 8. Check

```sh
alignfirst doctor
git status
```

The doctor must pass, and `git status` in the repository must show no change.

## For an Assistant

The [assistant contract](../SKILL.md#prepare-a-project-for-an-assistant) lives in the companion, except the workspace system and the Node version file. It changes these steps:

- **CLI and bootstrap (steps 1 and 7):** skip them. The deployment installs the CLI, and `aligndev code` puts the context into the launched agent's prompt.
- **Companion (step 2):** on an OpenClaw Dev Kit host, the assistant runs `alignfirst companion add` itself before it delegates the preparation.
- **Project config (step 3):** `.alignfirst.json` is required. For a project that declares ports, reserve its block with `aligndev project free-ports --size <n>` first, then write it as `portRange`.
- **Docs (step 5):** bootstrap `docs/` in the companion when the repository has none.
- **Developer guide:** write `DEVELOPERS.md` in the companion, without a workspaces section. The project runs in main-worktree mode: one working thread at a time, in the main worktree. Name the project's Node version there; the repository receives no `.nvmrc`.
- **Check (step 8):** `aligndev project doctor --root <projects-directory>` must pass too.

## Keep Only aligndev's Session Files Out

A project whose team uses AlignFirst keeps its files in the repository. When only `aligndev`'s session files must live elsewhere, the entry sets `{ ".plans": false, "_aligndev": true }`. This procedure does not apply.
