# Runbook: Project lifecycle

Use this procedure only to create a project, onboard a repository to clone, or physically remove a project. Project-workspace creation and cleanup follow `{{ALDEV}} guide project-workspace-setup` and the project's workspace tooling.

## Start with the project guide

Run `{{ALDEV}} guide project` and read the complete output before any lifecycle action. This call is mandatory for creation, onboarding, and removal; the JSON project inventory does not replace it. The sections it renders for each projects directory carry the host's allowed directories, their descriptions, and port ranges. The project kind supplies the range code: when the selected parent lists a matching coded range, pass its code with `--range`; the default range needs no flag. Follow those constraints throughout this procedure.

Each marked projects directory governs its own direct children. Apply only the selected parent's description and ranges; do not inherit an ancestor's creation policy. When that description permits the requested creation and the user explicitly says to proceed, continue without asking another person. Seek named-role approval only when the selected parent's description requires it.

## Create a project

Creation may begin with a proposed PROJECT and no PROJECT_PATH.

Project creation is bootstrap work, not an AlignFirst protocol. Through the initial commit, every delegation to the coder uses a fresh session with a plain message. Never pass `--protocol`, even when `.plans/` exists or the bootstrap resembles development work.

Before creating a directory, load the `alignfirst-setup-guide` skill. If the skill is unavailable or cannot be read, project creation is disabled: report that requirement and stop. Use the skill throughout the bootstrap.

Creation has a hard user-input gate. Before any filesystem, Git, port-allocation, plan, or delegation effect, the user must have supplied or approved the project name, selected parent, stack, and port requirements, including that no ports are needed. Do not fill these values from the projects guide or defaults. If any is missing, ask for all missing values and end the turn. For a new Node.js project whose user did not name an exact version, use the service user's current Node major for the version declaration; do not ask for a version separately.

1. Settle the stack, allowed parent directory, project name, and port requirements with the user. Use the `{{ALDEV}} guide project` output to constrain the choices.
2. Create the main-worktree directory under the selected allowed parent. Initialize its Git repository on `main`.
3. Once the directory contains its `.git` directory, retain the canonical path as PROJECT_PATH. When the project declares ports, run `{{ALDEV}} project free-ports --root <selected parent directory> --size <perWorkspace × maxWorkspaces> [--range <code>]` and retain the block; preparation through the setup guide writes it into `.alignfirst.json`. The selected parent's marker owns its port range. Report that `.alignfirst.json` was written and name the block.
4. Create `.plans/`, then run `{{ALIGNFIRST}} sync`. With an external ticket, run `{{ALIGNFIRST}} ticket {TICKET_ID} --next request.md` and append FILE_NAME to TICKET_DIR, exactly as printed, to get the path. Otherwise run `{{ALIGNFIRST}} ticket --side`; TICKET_ID is the reported `side-N`, and the path is `{TICKET_DIR}A1-request.md`. Write the complete creation request there from the starter and every later human message that supplied the gate's values. Record the project name, selected parent, stack, port requirements, and requested stopping point; never copy only the starter's task line. Then run `{{ALIGNFIRST}} sync`. The bot chooses the identifier and writes the request; the coder does neither. A later plans setup migrates this content when it replaces the directory with a symlink.
5. Before delegating the bootstrap, run `{{ALDEV}} guide code`. On a takeover turn, apply the pre-delegation race checkpoint in the playbook (`{{ALDEV}} guide`) immediately before `{{ALDEV}} code new`. Then bootstrap directly from PROJECT_PATH through `{{ALDEV}} code new --message`, with no protocol. Explicitly instruct it to use `alignfirst-setup-guide` and prepare the repository for an assistant. It must run `{{ALDEV}} project doctor` after writing `.alignfirst.json` and before workspace setup, stopping on an unhealthy inventory. Include `.local/` as a gitignored shared directory in the workspace mechanism. Follow the selected stack and the host-specific guide.
6. Verify the project through the setup guide, run `{{ALIGNFIRST}} sync`, and make its initial commit on `main` in PROJECT_PATH. Do not ask for confirmation before committing.
7. When a remote destination is known from the request, environment, or host instructions, configure it when needed and push `main`. Do not ask for confirmation before pushing. When no destination is known, or the user requested a local-only project, leave the committed project local and report that no remote was configured.
8. After that commit and push when applicable, return to the normal working-session flow. Every subsequent branch change uses a linked project workspace.

The direct main-worktree bootstrap is the creation exception. It ends with the initial commit and the push when a remote destination is known. If the user then requests more changes without a ticket, return to the working-session flow: reserve `side-N`, create a linked workspace, and delegate from it.

## Onboard a repository

The user hands you a repository URL to clone instead of asking for a new project. Onboarding is bootstrap work like creation. Before the project is prepared, every delegation to the coder uses a fresh session with a plain message, never a protocol.

### Step 1 — Clone and build

Before any discussion:

1. Select a parent directory allowed by `{{ALDEV}} guide project`. Ask the user when several qualify.
2. Clone the repository into that parent. PROJECT is the clone's directory name; PROJECT_PATH is its canonical path.
3. Retain the canonical path as PROJECT_PATH. Run `{{ALDEV}} project status <PROJECT_PATH>` and retain its `DEVELOPERS.md` path as DEVELOPERS_PATH. When the project's workspace wrapper declares ports, run `{{ALDEV}} project free-ports --root <selected parent directory> --size <perWorkspace × maxWorkspaces> [--range <code>]` and retain the block; preparation through the setup guide writes it into `.alignfirst.json`.
4. Install dependencies and build, following the repository's own README.

### Step 2 — Check the Dev Kit contract

The contract is the one the `alignfirst-setup-guide` lists under "Prepare a Project for an Assistant": AlignFirst skills configuration, docmap, the workspace system, and a `DEVELOPERS.md` with a workspaces section. The workspace system and its section belong to the contract only for a project that installs them; a project without them runs in main-worktree mode. When DEVELOPERS_PATH exists, the project is prepared: continue with the normal working-session flow for the user's request. Otherwise, continue to Step 3.

### Step 3 — Warn and ask

When the user says the repository must stay untouched, follow "Prepare through the companion" below instead of Steps 3 to 5.

End the turn on a message that explains the procedure: a branch created in the main worktree, preparation commits by the coder, a pull request the user must merge, and work waiting for that merge before the original request resumes.

Ask the user to approve this procedure and whether `.plans` must be shared through a work-files repository. If yes, ask for the repository URL. If no, `.plans` stays a plain directory. Wait for explicit approval.

### Step 4 — Prepare the project on a branch

On approval:

1. Create `.plans/` in the main worktree and run `{{ALIGNFIRST}} sync`. Run `{{ALIGNFIRST}} ticket --side` from PROJECT_PATH, write `{TICKET_DIR}A1-request.md` with the recorded request, then run `{{ALIGNFIRST}} sync`.
2. Create `{TICKET_ID}/alignfirst-setup` in the main worktree. This setup branch is the second main-worktree exception, next to new-project bootstrap.
3. Run `{{ALDEV}} guide code`. From PROJECT_PATH, delegate the preparation to the coder without a protocol: use the `alignfirst-setup-guide` skill and prepare the repository for an assistant, with the user's work-files repository decision and its URL. It must run `{{ALDEV}} project doctor` after writing `.alignfirst.json` and before workspace setup, stopping on an unhealthy inventory. Instruct the coder to commit and push the branch. The setup guide's rule against pushing addresses a human's laptop session, not this procedure.
4. Have the coder create a ready pull request, not a draft.
5. End the turn on the PR link and state that work resumes once the PR is merged.

### Step 5 — After the merge

When the user reports the merge, or you observe it while checking the PR:

1. In the main worktree, switch back to the default branch, pull, and delete the local setup branch.
2. Install dependencies and build.
3. When the user chose the work-files repository, clone it under `{{PROJECTS_ROOT}}` when no clone exists there (the projects guide names the repository), then run `{{ALIGNFIRST}} plans setup {{PROJECTS_ROOT}}/<clone>` from PROJECT_PATH. Otherwise, run `mkdir .plans`.
4. Run `{{ALDEV}} project doctor`. Stop when the inventory is unhealthy.
5. Run the project's `workspace setup` on the main worktree. Add `--profile remote` when the deployment sets `REMOTE_DEV_DOMAIN`.
6. Continue with the normal working-session flow for the original request through `{{ALDEV}} guide project-workspace-setup`.

### Prepare through the companion

The preparation targets the project's companion directory. It writes nothing in the repository and creates no branch, commit or pull request.

1. Read the `Companion:` line of `{{ALDEV}} project status <PROJECT_PATH>`. `(none)` means no entry of `~/.config/alignfirst/companions.json` matches the project. You cannot write that file: the deployment locks `~/.config/alignfirst/`. End the turn asking the operator for an entry covering PROJECT_PATH, and stop there.
2. Unless the user already said, ask whether `.plans` must be shared through a work-files repository, and for its URL if so. Wait for the answer.
3. When the user chose the work-files repository, clone it under `{{PROJECTS_ROOT}}` when no clone exists there.
4. Run `{{ALDEV}} guide code`. From PROJECT_PATH, delegate the preparation to the coder without a protocol: use the `alignfirst-setup-guide` skill and follow its procedure "Prepare a project through its companion", with the work-files clone path when there is one.
5. Run `{{ALDEV}} project doctor`. Stop when the inventory is unhealthy.
6. Continue with the normal working-session flow for the original request through `{{ALDEV}} guide project-workspace-setup`. The project runs in main-worktree mode.

## Remove a project

Removal requires the listed PROJECT_PATH selected before the thread opened or supplied by the user.

1. Run and read `{{ALDEV}} guide project`, then refresh `{{ALDEV}} project list --json` and resolve the listed project at PROJECT_PATH. Run `{{ALDEV}} project status <PROJECT_PATH>` and retain its `DEVELOPERS.md` path as DEVELOPERS_PATH, and its companion directory when it reports one. Read DEVELOPERS_PATH, then run and read the project workspace guide it names, if any.
2. A project in main-worktree mode (DEVELOPERS_PATH missing or without a workspaces section) has no linked workspace to enumerate: its list holds PROJECT_PATH alone. Otherwise, use the project workspace tooling to enumerate every registered linked workspace and its exact absolute path. Include the exact PROJECT_PATH for the main worktree.
3. Show the user the complete linked-worktree path list and the main-worktree path. Wait for explicit confirmation of those exact paths.
4. Remove each confirmed linked workspace through the project workspace tooling. Stop immediately if any removal fails; keep the main worktree intact.
5. Remove only the confirmed main-worktree directory at PROJECT_PATH. Leave every additional directory reported by the inventory untouched, the companion directory included.
6. Refresh `{{ALDEV}} project list --json`: the path must be absent from `projects`. Report any remaining workspace or filesystem discrepancy, and name the companion directory left in place.

Apply the host-specific and project-specific constraints read earlier throughout the sequence.
