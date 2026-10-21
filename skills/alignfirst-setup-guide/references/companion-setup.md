# Set Up a Project Through Its Companion

Use this procedure for a repository that must stay untouched. Its AlignFirst files live in a **companion directory**: one directory per project, outside the repository, that reproduces the project's layout for AlignFirst files only. The companion registry, `~/.alignfirst/companions/registry.json`, declares which projects have one, and where. `alignfirst` and `aligndev` read each item from the companion, so nothing is written in the repository.

This mode supports the AlignFirst protocols, the skills, the work files and docmap through the `alignfirst` CLI. It excludes the workspace system, the standalone `@alignfirst/docmap` package, a local `alignfirst` dependency, and any instruction-file section.

For a project prepared for an assistant, apply [For an Assistant](#for-an-assistant) to the steps below.

## 1. Skills

The commands below run the CLI through `npx`, with no installation. Install the skills through [Install the Skills](alignfirst-skills-setup.md#install-the-skills) when the user wants them. The `alignfirst` skill is unnecessary: `alignfirst context` prints the protocols.

## 2. Declare the companion

From the repository, register the project and read the layout:

```sh
npx -y alignfirst companion register [--dir <path>]
npx -y alignfirst config --json
```

`companion register` adds a companion for the project's main worktree, unless it already has one. A profile-only entry retains its original key and selection when gaining a directory. The new entry is `{ "dir": <path> }`. Pass `--dir` when the user wants the companion in a specific directory; without it, the companion goes under `~/.alignfirst/companions/`, with a name derived from the project path. The command refuses a directory that is or contains the home directory or `~/.alignfirst/companions`, or that overlaps the project or another companion.

The new entry leaves every item on `"auto"`: an existing companion copy wins, else an existing project copy stays in use, else the companion is the creation target. To force an item's location, add it to the entry's `items` as `"companion"` or `"project"`, then read the layout again.

`companion.dir` is the companion directory, and `locations` gives each item's path. The independent top-level `aligndev` field reports a project profile selection or null.

Write each item below at its `locations` path. Skip an item located in the project (`"in": "project"`): the repository provides it.

## 3. Project config

Write `.alignfirst.json`, following [With `.alignfirst.json`](alignfirst-skills-setup.md#with-alignfirstjson). The `.gitignore` line does not apply.

## 4. Project instructions

Write `.alignfirst-instructions/context.md` when the project needs instructions beyond `.alignfirst.json`, such as an essential-documentation list. It holds the prose a prepared project keeps in its `AGENTS.md`, without the bootstrap section. `alignfirst context` prints it.

## 5. Docs

A `docs/` directory in the repository stays in use. Otherwise, bootstrap one at the companion path through [docmap-bootstrapping.md](docmap-bootstrapping.md) when the user wants project documentation. `alignfirst docmap` reads it there.

## 6. Work files

Create `.plans` in the companion. With a work-files repository, run `npx -y alignfirst plans setup <clone>` from the repository: it creates the link at the companion location. Otherwise:

```sh
mkdir -p <companion>/.plans
```

## 7. Agent bootstrap

An agent reads a repository's `AGENTS.md` on its own, never a companion. Add the [global bootstrap line](alignfirst-skills-setup.md#repositories-without-alignfirst-instructions) for this project to the agent's global instruction file, after the user confirms. When the file already has the section, add the project's line to it.

## 8. Write access

An interactive coding agent asks before it writes outside the repository, and the companion lies outside it. With the user's consent, add the companions root to the agent's writable directories, or the companion directory itself when its `dir` lies outside that root:

- Claude Code: `permissions.additionalDirectories` in `~/.claude/settings.json`;
- Codex: `sandbox_workspace_write.writable_roots` in `~/.codex/config.toml`.

Write real paths: when `~/.alignfirst/companions` is a symlink, add its target. `companion.dir` from step 2 is already a real path. Skip a path the setting already covers.

## 9. Check

```sh
npx -y alignfirst doctor
git status
```

The doctor must pass, and `git status` in the repository must show no change.

## For an Assistant

The [assistant contract](../SKILL.md#prepare-a-project-for-an-assistant) lives in the companion, except repository-local tooling and runtime files. Full workspace installation is optional. It changes these steps:

- **Skills, bootstrap and write access (steps 1, 7 and 8):** skip them. The deployment installs the CLI globally, and `aligndev code` puts context into the launched agent's prompt. Claude Code/Codex normal modes receive `--add-dir <companion>`; Pi uses ordinary OS access and saved project trust.
- **Companion and work files (steps 2 and 6):** before ticket reservation, request capture or coding delegation, the assistant follows `aligndev guide work-files-setup`. This is the sole authorized preparation recipe for missing or project-tracked effective plans. It explicitly selects companion plans for all worktrees and preserves existing project work files without copying them. Usable plans need no preparation; a separate work-files repository and an unused tracked project copy do not block them.
- **Project config (step 3):** `.alignfirst.json` is required. For a project that declares ports, reserve its block with `aligndev project free-ports --size <n>` first, then write it as `portRange`.
- **Docs (step 5):** bootstrap `docs/` in the companion when the repository has none.
- **Developer guide:** write `DEVELOPERS.md` in the companion. Document existing project workspace tooling when present, including non-Node implementations. Otherwise use `aligndev worktree` for isolated work and record the repository's separate install/build/test and application-lifecycle commands. Companion plans resolve directly from every worktree, without a `.plans` link. Name runtime requirements there; the repository receives no version file.
- **Check (step 9):** `aligndev project doctor --root <projects-directory>` must pass too.

## Select a Profile Without a Companion

The same registry accepts `{ "aligndev": { "profile": "<name>" } }` under the project's main-worktree key. Edit it by hand; AlignDev validates the selected name against `code.profiles` in its settings. This entry creates no companion or separate session tree. Linked worktrees share the selection and keep their own project file locations.

An entry can contain both `dir` and `aligndev`. `companion unregister` removes `dir/items`, preserving the selection and reporting the remaining profile-only entry. Remove that selection through a separate registry edit. An entry with only `aligndev` has no companion to unregister.

## Keep Only aligndev's Session Files Out

When usable project-local plans stay effective and only `aligndev`'s session files must live elsewhere, the entry's `items` is `{ ".plans": "project", "_aligndev": "companion" }`. AlignDev requires those plans to be untracked by the project's own repository; a separate work-files repository remains supported. Standalone AlignFirst still permits tracked project plans. The full companion procedure does not apply.
