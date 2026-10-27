# Set Up a Project Through Its Companion

A companion holds selected AlignFirst files outside the product repository. Protocols, work files and Docmap can leave repository files untouched. Workspace adoption additionally requires local `.local-wt` runtime storage and Git exclusions; obtain approval for that footprint. Companions supply neither workspace recipes nor runtime storage.

## 1. Confirm scope

Inspect the project and obtain onboarding authorization. Install global command skills only when requested through [skills setup](alignfirst-skills-setup.md#install-the-skills). Assistant preparation skips command skills and global bootstrap installation. Do not change native coding-agent permission policy as part of workspace setup.

## 2. Register and select

From the main repository:

```sh
npx -y alignfirst companion register [--dir <path>]
npx -y alignfirst config --json
```

The default companion is under `~/.alignfirst/companions/`; relative `--dir` resolves there. Registration preserves independent profile selection and refuses unsafe overlaps. The registry is `~/.alignfirst/companions/registry.json`, keyed by main-worktree path under `projects`. Every linked worktree shares the selection.

For companion-only work files, set only `projects[companion.key].items[".plans"]` to `"companion"`, using the report's key. Preserve other entries, fields, item selections and profiles. Existing project plans stay untouched and unused; do not copy, merge, migrate, archive or delete them.

The six logical items are `alignfirst`, `.alignfirst-instructions`, `DEVELOPERS.md`, `docs`, `.plans` and `_aligndev`. `items.alignfirst` selects the configuration family, not an extension. With `auto`, an existing companion family wins, then project, then companion as creation destination. Explicit project/companion settings remain authoritative. Resolve location before extension; both JSON variants in the selected location fail. Legacy item keys require [the clean-break runbook](../../../docs/upgrading-multi-stack-workspaces.md).

Reread config. Verify `.plans` and each intended write resolve inside `companion.dir`. `locations.alignfirst` gives the actual selected filename or canonical `alignfirst.json` destination. Stop when explicit selection sends a required write into the project; resolve it with the user. Skip project-owned items that are already supplied there.

## 3. Prepare selected files

Write the project family using [project settings](alignfirst-skills-setup.md#with-alignfirstjson), including `schemaVersion: 1`. Add `.alignfirst-instructions/context.md` for project instructions beyond settings, without a bootstrap section. `alignfirst context` prints it.

Use existing repository docs; otherwise bootstrap selected companion docs when requested. Write `DEVELOPERS.md` at its verified destination for an assistant, documenting actual runtimes and install/build/test commands. No project runtime/version file is written in untouched mode.

Create effective companion `.plans` while preserving existing content. With a separately authorized work-files repository, `alignfirst plans setup <clone>` creates its link at that location. For assistant preparation, follow `aligndev guide work-files-setup` before ticket reservation, request capture or coding delegation, even when project plans are usable. Verify the same target/selection from existing linked worktrees. No redundant project `.plans` link is needed.

## 4. Optional workspaces

Use `npx -y alignfirst workspace` for every stack, with or without a manifest. Without a branch-local manifest, readiness is protocol-ready and performs no application installation, build, port allocation or startup. Do not place a port claim in companion settings. A configured project range belongs only in branch-local `devServer.ports` and requires separate repository-change approval.

Before setup, obtain approval to ignore `.local-wt/` through local Git exclusions and create local runtime storage. This changes Git metadata/filesystem state even when tracked files stay untouched. External owners adopt with setup and run teardown before their own deletion. See [workspace setup](workspace-setup.md).

## 5. Bootstrap and access

For a direct interactive developer, offer the project-specific [global context line](alignfirst-skills-setup.md#repositories-without-alignfirst-instructions) with approval. The agent does not auto-read companion `AGENTS.md`. Assistant deployments skip this: AlignDev supplies context to the coding child and retains existing native permission handling. A shared symlink does not grant sandbox access; report a refusal without widening permissions silently.

## 6. Check

Run `npx -y alignfirst doctor` and `git status`. In untouched protocol/docmap mode the repository must show no change. For an assistant, run `aligndev project doctor --root <projects-directory>` before workspace setup. No live registry or external consumer edits are authorized merely by reading this procedure.

## Independent profiles and session trees

A registry entry `{ "aligndev": { "profile": "name" } }` selects a profile without a companion or file relocation. A combined entry retains that selection when `companion unregister` removes `dir/items`; companion contents remain unless separately authorized for removal.

When only sessions should stay outside usable project plans, use `items: { ".plans": "project", "_aligndev": "companion" }`. Effective plans must remain untracked by the product repository. Shared work-files repositories are supported; a separate session tree stays independent.
