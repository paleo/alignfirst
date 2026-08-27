# Project lifecycle

Use this procedure only to create a project or physically remove one. Project-workspace creation and cleanup follow [`project-workspace-setup.md`](./project-workspace-setup.md) and the project's workspace tooling.

## Start with the project guide

Run `alproject --guide` and read the complete output before any lifecycle action. Its appended project-specific section carries the host's allowed parents and operating constraints. Follow those constraints throughout this procedure.

## Create a project

Creation may begin with a proposed PROJECT and no PROJECT_PATH.

Before creating a directory, load the `alignfirst-setup-guide` skill. If the skill is unavailable or cannot be read, project creation is disabled: report that requirement and stop. Use the skill throughout the bootstrap.

1. Settle the stack, allowed parent directory, project name, and port requirements with the user. Use the `alproject --guide` output to constrain the choices.
2. Create the main-worktree directory under the selected allowed parent. Initialize its Git repository on `main`.
3. Once the directory contains its `.git` directory, register the main worktree with `alproject`. Request a port allocation when required. Retain the canonical path as PROJECT_PATH and retain the reported base port and range.
4. Before delegating the bootstrap, run `alcode --openclaw-guide`. Then bootstrap directly from PROJECT_PATH through alcode, explicitly instructing it to use `alignfirst-setup-guide` and prepare the repository for an AlignFirst Developer. Include `.local/` as a gitignored shared directory in the workspace mechanism. Follow the selected stack and the host-specific guide.
5. Verify the project through the setup guide and make its initial commit on `main` in PROJECT_PATH. Do not ask for confirmation before committing.
6. When a remote destination is known from the request, environment, or host instructions, configure it when needed and push `main`. Do not ask for confirmation before pushing. When no destination is known, or the user requested a local-only project, leave the committed project local and report that no remote was configured.
7. After that commit and push when applicable, return to the normal working-session flow. Every subsequent branch change uses a linked project workspace.

The direct main-worktree bootstrap is the creation exception. It ends with the initial commit and the push when a remote destination is known.

## Remove a project

Removal requires the registered PROJECT_PATH selected before the thread opened or supplied by the user.

1. Refresh `alproject list --json` and resolve the registered project at PROJECT_PATH. Read `{PROJECT_PATH}/DEVELOPERS.md`, then run and read the project workspace guide it names.
2. Use the project workspace tooling to enumerate every registered linked workspace and its exact absolute path. Include the exact PROJECT_PATH for the main worktree.
3. Show the user the complete linked-worktree path list and the main-worktree path. Wait for explicit confirmation of those exact paths.
4. Remove each confirmed linked workspace through the project workspace tooling. Stop immediately if any removal fails; keep the main worktree and registration intact.
5. Remove only the confirmed main-worktree directory at PROJECT_PATH. Leave every additional directory reported by the inventory untouched.
6. After the main path is absent, run `alproject unregister <PROJECT_PATH>` to release the registration and port range.
7. Refresh `alproject list --json`. Report any remaining workspace, registration, or filesystem discrepancy.

Apply the host-specific and project-specific constraints read earlier throughout the sequence.
