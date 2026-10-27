# Set Up a Project Through Its Companion

A companion holds selected AlignFirst files, a complete workspace recipe and runtime outside the product repository. Protocols and Docmap can leave repository files untouched. Companion placement is not a write sandbox: shared-directory links, application commands, generated files, dependency installation and Git operations may still write project files.

## 1. Confirm scope

Inspect the project and obtain onboarding authorization. Install global command skills only when requested through [skills setup](alignfirst-skills-setup.md#install-the-skills). Assistant preparation skips command skills and global bootstrap installation. Preserve native coding-agent permission policy.

## 2. Register and select

From the main repository:

```sh
npx -y alignfirst companion register [--dir <path>]
npx -y alignfirst config --json
```

The default companion is under `~/.alignfirst/companions/`; relative `--dir` resolves there. Registration preserves independent profile selection and refuses unsafe overlaps. The registry is `~/.alignfirst/companions/registry.json`, keyed by main-worktree path under `projects`. Linked worktrees share that registration.

For all AlignFirst-owned files and runtime in the companion, set this registration's `defaultLocation` to `"companion"`. An explicit item overrides the default, including explicit `"auto"`. Omission preserves built-in defaults. Preserve other entries, fields, item selections and profiles. For plans-only preparation, set only `projects[companion.key].items[".plans"]` to `"companion"`, using the report's key. Existing project plans remain untouched and unused; do not copy, merge, migrate, archive or delete them.

The logical items are `alignfirst`, `.alignfirst-instructions`, `developerInstructions`, `workspaceRuntime`, `docs`, `.plans` and `_aligndev`. The retired `DEVELOPERS.md` item supplies no selection semantics.

- Ordinary `auto` selects an existing companion item, then project, then the companion creation destination. Explicit project/companion settings select that destination even when missing.
- `alignfirst` selects the whole `alignfirst.json`/`.jsonc` family. Both extensions in the selected location fail; sections are never merged across sources.
- `developerInstructions` selects the root for the configuration's explicit relative file reference. Without a reference its location is null, with no filename discovery.
- `workspaceRuntime` uses external storage only when effectively companion. Project/auto is always local, independent of directory existence.
- `_aligndev` accepts companion/auto. Explicit companion selects companion plans-shaped session storage; auto follows effective plans. When unset, a companion default selects companion sessions, otherwise sessions follow plans. Separate companion sessions with auto plans are rejected to prevent creation from changing plans selection.

Reread config. Verify `locations`, `selectionOrigins`, and that `.plans` and each intended write resolve inside `companion.dir`. `locations.alignfirst` identifies the actual selected filename or canonical `.json` destination. Stop if selection sends an unauthorized write into the project. Missing companion directories are destinations, not fallback signals. A profile-only registration supplies no companion placement.

## 3. Prepare selected files

Write one selected configuration using [project settings](alignfirst-skills-setup.md#with-alignfirstjson): `schemaVersion: 1`, optional URI-valued `$schema`, nested `conventions`, root `plans`, and optional recipe sections. For an assistant, choose a developer guide such as `DEVELOPERS.md` or `README.md`, record its relative path as `developerInstructions`, then write it at `locations.developerInstructions.path`. Include confirmed runtimes, commands and readiness boundaries. Run `alignfirst developer-instructions`; conventions appear first, followed by configured content and its source. A configured missing/unreadable file fails.

Add `.alignfirst-instructions/context.md` for coding-agent context beyond settings, without a bootstrap section. `alignfirst context` prints it; keep it distinct from human/assistant developer instructions. Use existing repository docs or bootstrap selected companion docs when requested. No project runtime/version file is written in untouched mode.

Create effective companion `.plans` while preserving existing content. With a separately authorized work-files repository, `alignfirst plans setup <clone>` creates its link at the selected location. Assistant preparation follows `aligndev guide work-files-setup` before ticket reservation, request capture or coding delegation, even when project plans are usable. Verify the same target/selection from existing linked worktrees. No redundant project plans link is needed.

Authored configuration, including executable sections and literal environment settings, may appear in reports/logs. Keep credentials in environment variables or ignored files. Reporting executes no commands and does not resolve environment bindings.

## 4. Optional workspaces

Follow [workspace setup](workspace-setup.md) for any stack. A companion-selected configuration may supply preparation, services, ports and cleanup. Commands default to the real target checkout; helpers beside configuration can use `${{ configurationDir }}` in argv. Project-selected recipes remain branch-local. A configuration without `workspace`/`devServer` gives protocol-ready defaults, without install/build/ports/startup. The sole port claim is the selected `devServer.ports`.

External runtime uses `<companion>/.local-wt/workspace-registry` directly and one path-derived runtime directory per real worktree under `<companion>/.local-wt/worktrees/`. It creates no checkout `.local-wt`, placeholder or registry link and needs no checkout runtime ignore rule. Project-local runtime instead requires ignored/untracked `.local-wt/`; obtain approval for Git exclusions and filesystem effects. Scripts use `ALIGNFIRST_WORKSPACE_CONTEXT.runtimeDir` for deliberately owned sidecars. Generated-file entries remain confined to the checkout.

External owners adopt with setup and run teardown before their own Git deletion. Teardown/down retain runtime files/logs. Remove/prune delete only verified target runtime after successful resource cleanup and, for remove, Git deletion. External deletion after teardown can leave runtime-only state for explicit prune.

## 5. Bootstrap and access

For a direct interactive developer, offer the project-specific [global context line](alignfirst-skills-setup.md#repositories-without-alignfirst-instructions) with approval. Agents do not auto-read companion `AGENTS.md`. Assistant deployments skip this: AlignDev supplies context to new coding children and retains native permission handling. A shared symlink grants no sandbox access; report refusals without silently widening permissions.

## 6. Check and change placement safely

Run `npx -y alignfirst doctor` and `git status`. Untouched protocol/Docmap preparation must show no repository changes. For an assistant, run `aligndev project doctor --root <projects-directory>` before workspace setup.

Before changing configuration source, placement or companion ownership, account for resources and clean under the old selection. No placement-history registry, migration-on-read or recovery of arbitrary manually hidden locations exists. Retain absolute paths for manual recovery. CLI unregister refuses outstanding resources or incomplete disposal, including force. It may retain clean data, reporting paths whose automatic discovery is being removed. Reading this procedure authorizes no live registry or external-consumer mutation.

## Independent profiles and session trees

A registry entry `{ "aligndev": { "profile": "name" } }` selects a profile without file relocation or a companion directory. A combined entry retains that selection when unregister removes `dir/items/defaultLocation`; companion contents remain unless deletion is separately authorized.

For sessions outside usable project plans, use `items: { ".plans": "project", "_aligndev": "companion" }`. Effective plans remain untracked by the product repository; shared work-files repositories are supported. Separate session histories stay independent.
