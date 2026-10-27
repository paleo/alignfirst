---
title: Companion Directories
summary: Logical file-family selection, the companion registry and the workspace-aware configuration report shared by AlignFirst and AlignDev.
read_when:
  - changing project or companion configuration discovery
  - changing alignfirst config --json or AlignDev's parser
  - debugging effective work files or a separate session tree
  - preparing a companion-backed project for workspace use
---

# Companion Directories

A companion holds selected AlignFirst files outside a product repository. Protocols and Docmap can leave repository files untouched. Workspace adoption additionally needs local runtime storage and Git metadata exclusions. See [companion setup](../skills/alignfirst-setup-guide/references/companion-setup.md) for the user-facing procedure and [the upgrade runbook](upgrading-multi-stack-workspaces.md) for retired settings.

## Registry and matching

`~/.alignfirst/companions/registry.json` is a fixed path, with no environment override. A symlink at `~/.alignfirst/companions` can relocate the registry and relative companion directories together.

```json
{
  "projects": {
    "~/projects/team-app": {
      "dir": "projects_team-app",
      "items": { "alignfirst": "companion", ".plans": "project", "_aligndev": "companion" },
      "aligndev": { "profile": "claude-work" }
    }
  }
}
```

Keys identify real main-worktree paths, absolute or `~/`. Linked worktrees share the main selection; arbitrary parent directories and Git remotes do not select projects. Existing paths compare by real path, absent ones by resolved path. Bare/non-Git directories have no companion match.

An entry requires `dir`, `aligndev`, or both. A relative dir resolves against the real companions directory; `~/` uses real home; absolute values remain absolute. `~` alone and `~otheruser` are invalid. A profile-only entry relocates no files and creates no companion/session tree. AlignFirst validates a nonblank profile; AlignDev owns named-profile resolution.

The registry tolerates unknown/obsolete properties with value-free stderr warnings, redacting dynamic project keys. Reads never rewrite it. Register/unregister preserve raw unknown fields and unrelated entries. Unreadable/malformed/invalid recognized registry data fails layout resolution. The obsolete `paths`/`root` layouts and filename-key selection require manual conversion; they supply no fallback semantics.

`companion register` refuses home/companions roots and unsafe project/other-companion overlaps. It retains existing profile selection. Without `--create-dir`, a missing companion is reported rather than created. Explicit `--dir` cannot redirect an existing registration silently. Unregister removes dir/items while preserving profile selection and reports retained contents. Directory deletion is separate and bounded; unsafe refusals change nothing. Doctor reports unmatched keys, shared/nested companions and missing explicitly selected items.

## Logical items and resolution

The logical items are `alignfirst`, `.alignfirst-instructions`, `developerInstructions`, `workspaceRuntime`, `docs`, `.plans` and `_aligndev`. Ordinary settings are project/companion/auto; `_aligndev` accepts companion/auto only. An explicit item overrides the registration's optional `defaultLocation`; otherwise the built-in default is auto. A profile-only registration cannot set placement. The retired `DEVELOPERS.md` item has no selection semantics.

| Selection | Location |
| --- | --- |
| project | Project copy, present or absent |
| companion | Companion copy, present or absent |
| auto | Existing companion copy, else existing project copy, else companion creation destination |

Without a companion every item uses the current project root. Discovery uses the current Git worktree root even from nested cwd; non-Git project settings use caller cwd and never search arbitrary parents.

`alignfirst` selects a family first, then its actual `alignfirst.json` or `alignfirst.jsonc` filename. Both in one selected location fail rather than establish precedence. An absent family has canonical `.json` creation destination. Project settings require `schemaVersion: 1`; strict JSON/JSONC differ only in syntax. Unknown nested/fixed fields fail, unlike tolerant global settings and registry data. There is no retired `.alignfirst.json` loader or `plans.folder` alias.

The selected `alignfirst.json`/`.jsonc` contains the complete configuration: `conventions` (ticket and Git settings), `plans`, optional `developerInstructions`, `workspace` and `devServer`. Sections are never merged across sources. Workspace recipes exist only when `workspace` or `devServer` is declared; a conventions-only file uses default preparation. One packaged editor schema covers the entire document. Future breaking majors require sequential in-memory converters retained throughout the CLI major; reads never rewrite committed settings.

`developerInstructions` is an explicit relative file reference. Its logical item chooses the root, with lexical and symlink containment checks. Without the setting, its location is null; no filename is discovered. Missing configured files remain reportable destinations.

`workspaceRuntime` uses companion storage only when its effective setting is companion. Project and auto always select project storage, independently of directory existence. The pure `resolveWorkspaceStorage(selection, target)` seam returns canonical identities, shared `registryDir` and target-specific `runtimeDir` without creating or claiming storage. Selected-registry ownership and generation-based runtime disposal are implemented in the kernel. External lifecycle integration remains pending; these intermediate builds must not operate on retained registries.

`_aligndev` identifies the plans-shaped directory beneath which session files are written. Explicit companion means `<companion>/.plans`; explicit auto follows effective plans. When unset, a companion default selects companion sessions; other defaults follow effective plans. A distinct session tree has its own `_archives/`; sync/archive/restore operate independently without crossing histories. Companion sessions with auto plans are rejected because creating the session tree could silently switch plans selection. Reads create no directories; writers create selected parents. Existence uses lstat so broken links remain errors in place.

## Report and ownership

AlignFirst owns parsing/resolution in `project-layout.ts`, cached per command. AlignDev never reads the registry; `src/project/layout.ts` invokes `alignfirst config --json` and requires this report:

```ts
interface ConfigReport {
  source: "project" | "companion" | null;
  config: ProjectConfig | null;
  aligndev: { profile: string } | null;
  companion: {
    dir: string;
    exists: boolean;
    key: string;
    defaultLocation: ItemSetting;
    items: Record<ItemName, ItemSetting | AligndevSetting>;
  } | null;
  locations: Record<Exclude<ItemName, "developerInstructions">, ItemLocation> & {
    developerInstructions: ItemLocation | null;
  };
  selectionOrigins: Record<ItemName, "item" | "defaultLocation" | "builtin">;
  workspace: {
    location: ItemLocation;
    registryDir: string;
    runtimeDir: string;
    schemaVersion: number | null;
    portRange: { first: number; last: number } | null;
    hasDevServer: boolean;
  };
}
```

`ItemLocation` carries an absolute `path`, `in: "project" | "companion"` and `exists`. `locations.alignfirst` and `workspace.location` identify the same selected merged file. `config` returns the full validated authored document, including executable commands and literal environment settings. Keep credentials in environment variables or ignored files; authored literals may appear in reports and logs. Inspection executes no commands, reads no inherited environment values and creates no storage. An absent file reports canonical `.json` path, null schema/range and false dev capability; a conventions-only file reports schema version 1 with no range/services. Invalid/ambiguous/unsupported files fail rather than choose defaults. Missing new report fields produce actionable AlignFirst upgrade diagnostics, not old-shape compatibility.

Independent `aligndev` profile selection is reported by config, doctor and project inventory without native agent/model resolution. AlignDev diagnostics identify the chosen structured command/runtime and available version; successful reports need no diagnostic subprocesses.

## Consumers

- **Context/conventions/tickets:** read selected settings and `.alignfirst-instructions/context.md`; display effective work-file paths, absolute when outside caller cwd. Guides append filenames to the reported ticket directory.
- **Plans/sync:** operate on effective plans and an optional separate session tree. Local directories, separately versioned shared plans and companion plans are supported. `plans setup` creates a relative link at the selected location only with its own authorization.
- **Docmap:** selected companion docs add an effective `--root` unless explicitly supplied. Standalone Docmap remains independent.
- **Coding launches:** require `plans check --json` before stale-session reconciliation, ticket/session writes or model discovery. Effective plans cannot be tracked by the product repository through logical/resolved aliases. Linked worktrees require main's real target and location selection. Historical status/help remain readable.
- **Child access:** AlignDev creates a missing selected companion before launch. Claude/Codex normal modes retain their narrow `--add-dir` behavior; Pi retains ordinary OS access and project trust. Shared symlinks grant no permissions. A new child's prompt includes companion context when selected files exist; resumes retain native context.
- **Workspace host:** resolves plans directly without a recursive config subprocess. Setup checks readiness before Git creation and validates linked parity after sharing. Companion plans need no generated `.plans` link. `.local-wt` remains local, ignored and untracked. Listing/cleanup do not require plans readiness, but safety metadata still validates.
- **Playbook:** preserves canonical project paths, explicit branches and selected workplaces. Both configured and default routes use `alignfirst workspace`. Work-files preparation is separately authorized before ticket reservation, capture, delegation or discussion recording. External owners use teardown before their deletion; remove never substitutes for external ownership.
- **Project inventory:** direct Git main worktrees are projects; work-files clones are classified separately. Root settings outside a Git project, shared companions and range conflicts are issues. Port claims come only from validated `workspace.portRange`, whose source is the selected configuration's `devServer.ports`.

## Bootstrap and boundaries

Agents auto-read project instructions, not companion instruction files. AlignDev supplies selected context to new coding children. Direct developers may opt into a global project-specific context line; companion registration alone installs none.

Moving a repository requires editing its main-path key with approval; remote matching and parent-directory inheritance are deliberately absent. Automatic bulk conversion and native permission-policy changes remain outside this feature.
