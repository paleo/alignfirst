# Prepare a Project for an Assistant

An assistant coordinates the conversation and delegates coding to a coding agent through AlignDev. Before any ticket, request capture or coding effect, the project meets the contract below.

## The Contract

1. **Context bootstrap and configuration.** The canonical context bootstrap is the first `##` section of `AGENTS.md` or `CLAUDE.md`, after the title and introduction. A selected `alignfirst.json` or `alignfirst.jsonc` with `schemaVersion: 1` is required for an assistant-managed project. Run `{{CMD}} setup init` and follow `{{CMD}} setup guide protocols`. A companion-only project places its selected instructions and settings outside the repository.
2. **Work files.** Effective plans are usable and untracked by the product repository. A separate work-files repository may track them. When plans are missing or project-tracked, follow the separately authorized `aligndev guide work-files-setup` before any ticket reservation, request capture or coding effect. Preserve old history without unsolicited copying. See `{{CMD}} setup guide work-files` for a work-files repository.
3. **Documentation.** The project has Docmap and meaningful docs. When `docs/` is absent and documentation is part of the preparation, follow `{{CMD}} setup guide docmap-bootstrap`.
4. **Workspace.** Every stack is prepared through `{{CMD}} workspace`, with or without a recipe. Without `workspace` or `devServer`, setup is protocol-ready and performs no install, build or start; document the separate stack commands. Prepare effective plans and the selected runtime storage first. Only project-local runtime requires an ignored, untracked `.local-wt/`. A companion runtime needs no checkout runtime directory or exclusions. See `{{CMD}} setup guide workspace`.
5. **Runtime requirements.** They are confirmed. A Node project's `.nvmrc`, `.node-version` or `engines.node` is honored. Without a declaration, use the current Node LTS unless the project's requirements say otherwise. Python and other runtimes keep their documented tools. Running the CLI through Node or Bun does not change project commands.
6. **Assistant guide.** The project has an assistant guide, recorded as `assistantInstructionsFile`. See "The Assistant Guide" below.
7. **Inventory.** `aligndev project doctor` passes after the configuration and recipe are written, and before workspace setup. It scans `projectsRoot` of the aligndev settings, else the working directory; `--root <path>` scans another root. A port range belongs solely in `devServer.ports`. `aligndev project free-ports` is a lookup in `portRange` of the aligndev settings.

## The Assistant Guide

The assistant guide is the project-specific entry point of an assistant session, commonly `DEVELOPERS.md` or `README.md`.

A `DEVELOPERS.md` is titled `# Developer Reference`. It contains the confirmed daily development commands, especially build and test, and the project-specific guidance needed to use them. It lists relevant project constraints. It links to the most important documentation when that helps the assistant begin work; keep this selection short. When these details are undecided, the title alone is sufficient. Omit generic AlignFirst explanations, full documentation indexes, status filler and verification lists for the setup itself. Detailed project documentation belongs in `docs/`, discovered through Docmap.

Local installation goes in the README, with public URLs when services exist. Tool-specific lifecycle hooks stay in the tool's configuration.

Record the guide's relative path explicitly as `assistantInstructionsFile` in the selected `alignfirst.json` or `.jsonc`. Without this reference, no filename fallback applies.

Run `{{CMD}} assistant-instructions` from the selected worktree to read the guide. It prints the project guidance and any configured content with its absolute source path. Missing configured content is an error.

To find the file to edit, including under companion placement, read the nullable `locations.assistantInstructionsFile` in `{{CMD}} config --json`.

Keep this human and assistant guide distinct from the coding agent's `AGENTS.md` or companion context. Do not copy entire documents between them.

## Boundaries

Assistant preparation skips command-skill installation and global bootstrap changes unless they are separately requested.

Companion-only preparation follows the authorization and location checks of `{{CMD}} setup guide companion`, including its rules for changing placement.

Native coding-agent permissions are unchanged. Coding delegation and its native permissions stay separate from workspace preparation; a shared symlink grants no sandbox access. Explicit shared directories, project commands and Git metadata remain writable. Report protected-path refusals rather than bypassing them.
