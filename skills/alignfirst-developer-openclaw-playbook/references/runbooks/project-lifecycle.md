# Project lifecycle

Use this procedure only to create a project, onboard a repository to clone, or physically remove a project. Project-workspace creation and cleanup follow [`project-workspace-setup.md`](./project-workspace-setup.md) and the project's workspace tooling.

## Start with the project guide

Run `alcode projects --guide --root ~/projects` and read the complete output before any lifecycle action. This call is mandatory for creation, onboarding, and removal; the JSON project inventory does not replace it. The sections it renders for each projects directory carry the host's allowed directories, their descriptions, and port ranges. Follow those constraints throughout this procedure.

## Create a project

Creation may begin with a proposed PROJECT and no PROJECT_PATH.

Project creation is bootstrap work, not an AlignFirst protocol. Through the initial commit, every alcode delegation uses a fresh session with a plain message. Never pass `--protocol`, even when `.plans/` exists or the bootstrap resembles development work.

Before creating a directory, load the `alignfirst-setup-guide` skill. If the skill is unavailable or cannot be read, project creation is disabled: report that requirement and stop. Use the skill throughout the bootstrap.

1. Settle the stack, allowed parent directory, project name, and port requirements with the user. Use the `alcode projects --guide --root ~/projects` output to constrain the choices.
2. Create the main-worktree directory under the selected allowed parent. Initialize its Git repository on `main`.
3. Once the directory contains its `.git` directory, retain the canonical path as PROJECT_PATH. When the project declares ports, run `alcode projects free-ports --root ~/projects --size <perWorkspace × maxWorkspaces>` and retain the block; preparation through the setup guide writes it into `.alignfirst.json`. Report that `.alignfirst.json` was written and name the block.
4. Read the `alignfirst` skill and create `.plans/`. Use the external ticket ID when the request has one. Otherwise run `alignfirst ticket --side` from PROJECT_PATH; it creates `.plans/side-N/` and prints the directory. TICKET_ID is the `side-N` it reports. Write `.plans/{TICKET_ID}/A1-request.md` with the complete creation request. The bot chooses the identifier and writes the request; alcode does neither. A later plans setup migrates this content when it replaces the directory with a symlink.
5. Before delegating the bootstrap, run `alcode --openclaw-guide`. Then bootstrap directly from PROJECT_PATH through `alcode new --message`, with no protocol. Explicitly instruct it to use `alignfirst-setup-guide` and prepare the repository for an AlignFirst Developer. It must run `alcode projects doctor --root ~/projects` after writing `.alignfirst.json` and before workspace setup, stopping on an unhealthy inventory. Include `.local/` as a gitignored shared directory in the workspace mechanism. Follow the selected stack and the host-specific guide.
6. Verify the project through the setup guide, synchronize the request artifact when the prepared project documents a plans command, and make its initial commit on `main` in PROJECT_PATH. Do not ask for confirmation before committing.
7. When a remote destination is known from the request, environment, or host instructions, configure it when needed and push `main`. Do not ask for confirmation before pushing. When no destination is known, or the user requested a local-only project, leave the committed project local and report that no remote was configured.
8. After that commit and push when applicable, return to the normal working-session flow. Every subsequent branch change uses a linked project workspace.

The direct main-worktree bootstrap is the creation exception. It ends with the initial commit and the push when a remote destination is known. If the user then requests more changes without a ticket, return to the working-session flow: reserve `side-N`, create a linked workspace, and delegate from it.

## Onboard a repository

The user hands you a repository URL to clone instead of asking for a new project. Onboarding is bootstrap work like creation. Before the project is prepared, every alcode delegation uses a fresh session with a plain message, never a protocol.

### Step 1 — Clone and build

Before any discussion:

1. Select a parent directory allowed by `alcode projects --guide --root ~/projects`. Ask the user when several qualify.
2. Clone the repository into that parent. PROJECT is the clone's directory name; PROJECT_PATH is its canonical path.
3. Retain the canonical path as PROJECT_PATH. When the project's workspace wrapper declares ports, run `alcode projects free-ports --root ~/projects --size <perWorkspace × maxWorkspaces>` and retain the block; preparation through the setup guide writes it into `.alignfirst.json`.
4. Install dependencies and build, following the repository's own README.

### Step 2 — Check the AlignFirst Developer contract

The contract is the one the `alignfirst-setup-guide` lists under "Prepare a Project for an AlignFirst Developer": AlignFirst skills configuration, docmap, the workspace system, and a `DEVELOPERS.md` with a workspaces section. When `DEVELOPERS.md` exists with its workspaces section, the project is prepared. Continue with the normal working-session flow for the user's request. Otherwise, continue to Step 3.

### Step 3 — Warn and ask

End the turn on a message that explains the procedure: a branch created in the main worktree, preparation commits by the coding agent, a pull request the user must merge, and work waiting for that merge before the original request resumes.

Ask the user to approve this procedure and whether `.plans` must be shared through a team plans repository. If yes, ask for the repository URL. If no, `.plans` stays a plain directory. Wait for explicit approval.

### Step 4 — Prepare the project on a branch

On approval:

1. Create `.plans/` in the main worktree. Run `alignfirst ticket --side` from PROJECT_PATH, then write `.plans/{TICKET_ID}/A1-request.md` with the recorded request, as in project creation.
2. Create `{TICKET_ID}/alignfirst-setup` in the main worktree. This setup branch is the second main-worktree exception, next to new-project bootstrap.
3. Run `alcode --openclaw-guide`. From PROJECT_PATH, delegate the preparation to alcode without a protocol: use the `alignfirst-setup-guide` skill and prepare the repository for an AlignFirst Developer, with the user's team plans decision and repository URL. It must run `alcode projects doctor --root ~/projects` after writing `.alignfirst.json` and before workspace setup, stopping on an unhealthy inventory. Instruct alcode to commit and push the branch. The setup guide's rule against pushing addresses a human's laptop session, not this procedure.
4. Have alcode create a ready pull request, not a draft.
5. End the turn on the PR link and state that work resumes once the PR is merged.

### Step 5 — After the merge

When the user reports the merge, or you observe it while checking the PR:

1. In the main worktree, switch back to the default branch, pull, and delete the local setup branch.
2. Install dependencies and build.
3. When the user chose the team plans repository, clone it under `~/projects` when no clone exists there (the projects guide names the repository), then run `alignfirst plans setup ~/projects/<clone>` from PROJECT_PATH. Otherwise, run `mkdir .plans`.
4. Run `alcode projects doctor --root ~/projects`. Stop when the inventory is unhealthy.
5. Run the project's `workspace setup` on the main worktree. Add `--profile remote` when the deployment sets `REMOTE_DEV_DOMAIN`.
6. Continue with the normal working-session flow for the original request through `project-workspace-setup.md`.

## Remove a project

Removal requires the listed PROJECT_PATH selected before the thread opened or supplied by the user.

1. Run and read `alcode projects --guide --root ~/projects`, then refresh `alcode projects list --json --root ~/projects` and resolve the listed project at PROJECT_PATH. Read `{PROJECT_PATH}/DEVELOPERS.md`, then run and read the project workspace guide it names.
2. Use the project workspace tooling to enumerate every registered linked workspace and its exact absolute path. Include the exact PROJECT_PATH for the main worktree.
3. Show the user the complete linked-worktree path list and the main-worktree path. Wait for explicit confirmation of those exact paths.
4. Remove each confirmed linked workspace through the project workspace tooling. Stop immediately if any removal fails; keep the main worktree intact.
5. Remove only the confirmed main-worktree directory at PROJECT_PATH. Leave every additional directory reported by the inventory untouched.
6. Refresh `alcode projects list --json --root ~/projects`: the path must be absent from `projects`. Report any remaining workspace or filesystem discrepancy.

Apply the host-specific and project-specific constraints read earlier throughout the sequence.
