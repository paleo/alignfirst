# Prepare a Project Through Its Companion

Use this procedure for a repository that must stay untouched. Its AlignFirst files live in a **companion directory**: one directory per project, outside the repository, that reproduces the project's layout for AlignFirst files only. `~/.config/alignfirst/companions.json` declares which projects have one. `alignfirst` and `aldev` read each item from the companion, so nothing is written in the repository.

The `alignfirst` package README documents the file: its schema, how an entry matches a project, and how each item resolves.

## 1. Check the entry

A matching `companions.json` entry must exist. The user or the operator writes it. An assistant cannot: the Dev Kit locks `~/.config/alignfirst/`. From the repository, read the layout:

```sh
npx alignfirst config --json
```

`companion.dir` is the companion directory, and `locations` gives each item's path. With `companion: null`, stop and ask for an entry.

Write each item below at its companion path, `<companion>/<item>`. Under the default `"auto"` flag, a companion copy takes precedence over a repository copy once it exists.

## 2. Project config

Write `.alignfirst.json` in the companion, following [With `.alignfirst.json`](alignfirst-skills-setup.md#with-alignfirstjson). The `.gitignore` line does not apply. For an assistant-managed project that declares ports, reserve its block with `aldev project free-ports --size <n>` first, then write it as `portRange`.

## 3. Project instructions

Write `.alignfirst.md` in the companion. It holds the project instructions a prepared project keeps in its `AGENTS.md`, including the essential-documentation list, without the bootstrap section. `alignfirst context` prints the file. A developer's agent runs that command through the [global bootstrap line](alignfirst-skills-setup.md#repositories-without-alignfirst-instructions).

## 4. Docs

Bootstrap `docs/` through [docmap-bootstrapping.md](docmap-bootstrapping.md), writing under the companion path the report gives. `alignfirst docmap` reads it there.

## 5. Work files

Create `.plans` in the companion. With a work-files repository, run `npx alignfirst plans setup <clone>` from the repository: it creates the link at the companion location when the entry targets it. Otherwise:

```sh
mkdir -p <companion>/.plans
```

## 6. Developer guide

Write `DEVELOPERS.md` in the companion, without a workspaces section. The project runs in main-worktree mode: one working thread at a time, in the main worktree.

## 7. Node version

Name the project's Node version in `DEVELOPERS.md`. The repository receives no `.nvmrc`.

## 8. Check

```sh
aldev project doctor --root <projects-directory>
git status
```

The doctor must pass, and `git status` in the repository must show no change.

## Keep only aldev's session files out

A project whose team uses AlignFirst keeps its files in the repository. When only `aldev`'s session files must live elsewhere, the entry sets `{ ".plans": false, "_aldev": true }`. This procedure does not apply.
