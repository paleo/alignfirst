---
title: Project Overlays
summary: A future feature of the alignfirst CLI — keeping a project's AlignFirst files outside its repository. Records the design implemented on branch 78 and dropped before merge, its contracts, its weaknesses and the seams kept for it.
read_when:
  - designing or implementing overlays in the alignfirst CLI
  - changing project config resolution, the `config` report or the guide's conventions section, which must stay overlay-compatible
  - preparing an AlignFirst Developer for a repository that must stay untouched
---

# Project Overlays

**Status: proposal.** The feature was implemented on branch `78/unified-cli` and dropped before the merge, because it had no user yet and touched most commands. This document is the record of that design; the codebase will have changed by the time it returns, so a new implementation starts from these contracts rather than from the old code.

## Goal

An AlignFirst Developer sometimes works in a repository that must stay untouched, a client's repository for instance. Today a prepared project carries its AlignFirst files at its root: `.alignfirst.json`, the AlignFirst section of `AGENTS.md`, `DEVELOPERS.md` and `docs/`. An overlay holds these files outside the repository, and every command resolves each file in the project root first, then in the overlay. A prepared project never meets the feature.

The only footprint left in the repository is the `.plans` symlink, registered in `.git/info/exclude` so it stays invisible to every other clone. Workspaces stay out of scope: `workspace.mjs`, its script and its devDependency remain the one footprint an untouched repository must accept.

## Layout

`ALIGNFIRST_OVERLAYS` names the directory holding the overlays. Each overlay is `<ALIGNFIRST_OVERLAYS>/<name>/_project/`. The underscore keeps it out of the ticket listing, like `_archives`.

The recommended value is the team plans clone. A project's overlay then sits next to its tickets, is versioned, shared with the team, and travels with `alignfirst sync`. The AlignFirst Developer template set the variable in `environment.d/common.conf` to `~/projects/<plans-clone>`. Any other directory works.

An overlay holds any of: `.alignfirst.json`, `AGENTS.md`, `DEVELOPERS.md`, `docs/`.

## Matching a repository to its overlay

The overlay's `.alignfirst.json` carries a `project` key that identifies the repository:

```json
{
  "schemaVersion": 1,
  "project": { "remote": "github.com/org/repo", "paths": ["/abs/path/to/repo"] }
}
```

At least one of `remote` and `paths` is required; `paths` holds absolute paths only. The key is meaningful in an overlay only.

`findOverlay(cwd, env, home)` runs only when `ALIGNFIRST_OVERLAYS` is set. It reads `<overlays>/*/_project/.alignfirst.json`, expands a leading `~/`, and keeps the overlay whose `project.remote` equals the normalized `origin` URL of the working directory, else whose `project.paths` contains its real path. Remote matches take precedence over path matches. Two matches at the same level is an error naming both directories.

URL normalization gives `host/org/repo` for both the scp form `git@Host:org/repo.git` and the URL form `https://user@host:8443/org/repo.git`: lowercase host, user, scheme and port removed, trailing slashes and `.git` removed. The rest of the path keeps its case.

## Resolution

`resolveProjectConfig(cwd, env, home)` returns the root config when the file exists, else the overlay's config, else nothing. The result carries `source` (`root` or `overlay`) and the matched overlay, even when the root copy wins. The version guard reads the `cli` range from the effective config, so an overlay config guards the CLI version too.

`resolveProjectFile(cwd, overlay, name)` applies the same rule to `AGENTS.md`, `DEVELOPERS.md` and `docs`: the root copy when it exists, else the overlay's. For `docs/`, the root wins even when its tree is not in docmap format, so the rule stays simple.

## Command behaviors

- `guide` appended the overlay's `AGENTS.md` to the core guide under a `## Project conventions` heading, only when the overlay copy was the one in use. This carried the conventions a prepared project keeps in its AGENTS.md section to an agent that never reads an overlay.
- `docmap` appended `--root <overlay>/docs` to docmap's arguments when the arguments carried no `--root`, the working directory had no `docs/`, and the overlay had one.
- `config` reported `source: overlay` and an `overlay` object `{ dir, matchedBy }`; the overlay line appeared whenever an overlay matched, even with a root config.
- `doctor` had an `Overlay` section: the matched overlay, the matching key, and for each of the four files which copy was in use.
- `DEVELOPERS.md` printed the root file, else the overlay's, else an error listing both paths tried. The command existed only for overlays: in a prepared project the agent reads the file directly.
- `setup --overlay [--plans-folder <name>] [--ticket-pattern <regex>] [--port-range <first>-<last>]`, run from the main worktree root of the untouched repository, required `ALIGNFIRST_OVERLAYS`. The overlay name was `--plans-folder`, else the repository directory's basename. It created `<overlays>/<name>/_project/`, wrote its `.alignfirst.json` with `project.remote` from the normalized `origin` URL when there was one, `project.paths` with the repository's real path, the given options and no `cli` range; an existing overlay directory was an error. When `ALIGNFIRST_OVERLAYS` was inside a git repository, `.plans` became a relative symlink to `<overlays>/<name>/`, the same link `plans setup` creates, otherwise `.plans` was created as a plain directory. Finally `.plans` was appended to `.git/info/exclude` unless `git check-ignore -q .plans` already succeeded.
- `setup --adopt`, when the team adopts AlignFirst in the repository: moved the overlay's `.alignfirst.json` without its `project` key, then `AGENTS.md`, `DEVELOPERS.md` and `docs/` to the root, each only when the root lacked it, reporting the conflicts it left. It removed the `.plans` line from `.git/info/exclude` and the `_project/` directory when empty, and printed what remained for the agent: the `.plans` ignore rule and, on conflict, the `AGENTS.md` conventions to merge by hand.

## Touchpoints in `alproject`

Discovery describes each child directory with `alignfirst config --json`. `source: overlay` listed the child as a project in overlay mode with the overlay directory recorded; `status` reported the overlay path as the config source. When `ALIGNFIRST_OVERLAYS` was set, every `<overlays>/*/_project/` directory that no listed project reported as its overlay was an issue, "unmatched overlay". The projects guide template described a project as a child whose config report finds a root or overlay config.

## Seams kept in the CLI

The removal kept the design compatible:

- Every command reads the project config through one resolution function. Adding the overlay source changes that function alone.
- The `config` report keeps its `source` field, `root` or `null`, so `overlay` can return as a value, and `alproject` keeps reading it.
- `guide` keeps one append point for project conventions.

## Known weaknesses

Recorded when the feature was designed; none was resolved.

- **No auto-loaded instructions.** An agent reads a project's `AGENTS.md` on its own and never an overlay's. The agent runs `alignfirst guide`, or now `alignfirst context`, because the user's global instructions say so. This footprint moves from the project to the user, and a developer without that line works as if AlignFirst were absent.
- **Fragile matching.** A fork, a mirror or a renamed remote changes the `origin` URL, and the path fallback is per machine. A wrong match silently serves another project's conventions; `doctor` was the only place showing the match.
- **Two homes per file.** Every command must apply the root-then-overlay rule identically, including `docmap` on a root `docs/` tree that is not in docmap format.
- **Documentation does not travel with the code.** No pull request shows an overlay's docs and no CI checks them. The recommendation remains a `docs/` tree in the repository; the overlay lets the AlignFirst Developer start with less friction and documents the project until its team adopts docmap.

## Questions for the next design

The CLI changed since the implementation: conventions became structured fields of `.alignfirst.json` rendered by `alignfirst conventions`, `alignfirst context` chains them with docmap, `setup` disappeared and the setup guide writes the project config itself.

- With structured conventions, does an overlay still need an `AGENTS.md`? The overlay's `.alignfirst.json` carries the conventions, and `conventions` renders them through the resolution function. The `guide` append point may then be unnecessary.
- The bootstrap for an untouched repository is one line in the AlignFirst Developer's global agent instructions, presumably `alignfirst context`. Decide whether a human developer gets the same line or the feature stays AlignFirst-Developer-only.
- Without `setup`, who creates the overlay? Either the setup guide writes the directory, the `project` key, the `.plans` symlink and the exclude entry by hand, or a single command returns for this one mechanical, multi-step operation.
- Is `project.paths` worth keeping? It is per machine and was only a fallback for a repository without a remote.
- Is `--adopt` needed on day one? It is the exit path from the feature and can come with the first team that adopts.
- `config --json` should report the overlay only when it matched, so `alproject` can keep its "unmatched overlay" check.
