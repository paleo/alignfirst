# Runbook: Project lifecycle

Use this procedure only to create a project, onboard a repository to clone, or physically remove a project. Project-workspace creation and cleanup follow `{{GUIDE}} project-workspace-setup`.

## Start with the project guide

Run `{{ALIGNDEV}} guide project` and read the complete output before any lifecycle action. This call is mandatory for creation, onboarding, and removal; the JSON project inventory does not replace it. The sections it renders for each projects directory carry the host's allowed directories, their descriptions, and port ranges. The project kind supplies the range code: when the selected parent lists a matching coded range, pass its code with `--range`; the default range needs no flag. Follow those constraints throughout this procedure.

Each marked projects directory governs its own direct children. Apply only the selected parent's description and ranges; do not inherit an ancestor's creation policy. When that description permits the requested creation and the user explicitly says to proceed, continue without asking another person. Seek named-role approval only when the selected parent's description requires it.

## Create a project

Creation may begin with a proposed PROJECT and no PROJECT_PATH.

Project creation is bootstrap work, not an AlignFirst protocol. Through the initial commit, every delegation to the agent uses a fresh session with a plain message. Never pass `--protocol`, even when `.plans/` exists or the bootstrap resembles development work.

Before creating a directory, load the `alignfirst-setup-guide` skill. If the skill is unavailable or cannot be read, project creation is disabled: report that requirement and stop. Use the skill throughout the bootstrap.

Creation has a hard user-input gate. Before any filesystem, Git, port-allocation, plan, or delegation effect, the user must have supplied or approved the project name, selected parent, stack, and port requirements, including that no ports are needed. Do not fill these values from the projects guide or defaults. If any is missing, ask for all missing values and end the turn. For a new Node.js project whose user did not name an exact version, use the service user's current Node major for the version declaration; do not ask for a version separately.

1. Settle the stack, allowed parent directory, project name, and port requirements with the user. Use the `{{ALIGNDEV}} guide project` output to constrain the choices.
2. Create the main-worktree directory under the selected allowed parent. Initialize its Git repository on `main`.
3. Once the directory contains its `.git` directory, retain the canonical path as PROJECT_PATH. When the project declares ports, run `{{ALIGNDEV}} project free-ports --root <selected parent directory> --size <port names × concurrent workspaces> [--range <code>]` and retain the block; preparation through the setup guide writes it into `devServer.ports` in the selected `alignfirst.json` or `.jsonc`. The selected parent's marker owns its port range. Report the manifest path and block.
{{#thread}}
4. Complete `{{GUIDE}} work-files-setup` with the approved bootstrap scope, then run `{{ALIGNFIRST}} sync`. With an external ticket, run `{{ALIGNFIRST}} ticket {TICKET_ID} --next request.md` and append FILE_NAME to TICKET_DIR, exactly as printed, to get the path. Otherwise run `{{ALIGNFIRST}} ticket --side`; TICKET_ID is the reported `side-N`, and the path is `{TICKET_DIR}A1-request.md`. Write the complete creation request there from the starter and every later human message that supplied the gate's values. Record the project name, selected parent, stack, port requirements, and requested stopping point; never copy only the starter's task line. Then run `{{ALIGNFIRST}} sync`. You choose the identifier and write the request; the agent does neither. A later plans setup migrates this content when it replaces the directory with a symlink.
{{/thread}}
{{#app}}
4. Complete `{{GUIDE}} work-files-setup` with the approved bootstrap scope, then run `{{ALIGNFIRST}} sync`. With an external ticket, run `{{ALIGNFIRST}} ticket {TICKET_ID} --next request.md` and append FILE_NAME to TICKET_DIR, exactly as printed, to get the path. Otherwise run `{{ALIGNFIRST}} ticket --side`; TICKET_ID is the reported `side-N`, and the path is `{TICKET_DIR}A1-request.md`. Write the complete creation request there from this conversation, every human message that supplied the gate's values included. Record the project name, selected parent, stack, port requirements, and requested stopping point. Then run `{{ALIGNFIRST}} sync`. You choose the identifier and write the request; the agent does neither. A later plans setup migrates this content when it replaces the directory with a symlink.
{{/app}}
{{#thread}}
5. Before delegating the bootstrap, run `{{GUIDE}} code`. On a takeover turn, apply the pre-delegation race checkpoint in the playbook (`{{GUIDE}}`) immediately before `{{ALIGNDEV}} code new`. Then bootstrap directly from PROJECT_PATH through `{{ALIGNDEV}} code new --message`, with no protocol. Instruct it to use `alignfirst-setup-guide`, prepare `alignfirst.json`, effective plans and ignored `.local-wt/`, then run `{{ALIGNDEV}} project doctor` before `{{ALIGNFIRST}} workspace setup`. Stop on unhealthy inventory. The manifest is optional; defaults are protocol-ready. Document the stack's separate install/build/test commands.
{{/thread}}
{{#app}}
5. Before delegating the bootstrap, run `{{GUIDE}} code`. Then bootstrap directly from PROJECT_PATH through `{{ALIGNDEV}} code new --message`, with no protocol. Instruct it to use `alignfirst-setup-guide`, prepare `alignfirst.json`, effective plans and ignored `.local-wt/`, then run `{{ALIGNDEV}} project doctor` before `{{ALIGNFIRST}} workspace setup`. Stop on unhealthy inventory. The manifest is optional; defaults are protocol-ready. Document the stack's separate install/build/test commands.
{{/app}}
6. Verify the project through the setup guide, run `{{ALIGNFIRST}} sync`, and make its initial commit on `main` in PROJECT_PATH. Do not ask for confirmation before committing.
7. When a remote destination is known from the request, environment, or host instructions, configure it when needed and push `main`. Do not ask for confirmation before pushing. When no destination is known, or the user requested a local-only project, leave the committed project local and report that no remote was configured.
8. After that commit and push when applicable, return to the normal working-session flow. Every subsequent branch change uses a linked project workspace.

The direct main-worktree bootstrap is the creation exception. It ends with the initial commit and the push when a remote destination is known. If the user then requests more changes without a ticket, return to the working-session flow: reserve `side-N`, create a linked workspace, and delegate from it.

## Onboard a repository

The user hands you a repository URL to clone instead of asking for a new project. Onboarding is bootstrap work like creation. Before the project is prepared, every delegation to the agent uses a fresh session with a plain message, never a protocol.

### Step 1 — Clone and build

Before any discussion:

1. Select a parent directory allowed by `{{ALIGNDEV}} guide project`. Ask the user when several qualify.
2. Clone the repository into that parent. PROJECT is the clone's directory name; PROJECT_PATH is its canonical path.
3. Retain the canonical path as PROJECT_PATH. Run `{{ALIGNFIRST}} developer-instructions` there. When the project's selected configuration declares ports, run `{{ALIGNDEV}} project free-ports --root <selected parent directory> --size <port names × concurrent workspaces> [--range <code>]` and retain the block; preparation through the setup guide writes it into `devServer.ports` in the selected `alignfirst.json` or `.jsonc`.
4. Install dependencies and build, following the repository's own README.

### Step 2 — Check the AlignDev contract

The contract is the one the `alignfirst-setup-guide` lists under "Prepare a Project for an Assistant": project context, usable work files outside the project's tracked tree, documentation, runtime commands, and a developer guide. The workspace manifest is optional. Run `{{ALIGNFIRST}} config --json` and `{{ALIGNFIRST}} developer-instructions` from PROJECT_PATH. The project is prepared when the explicitly configured `locations.developerInstructions` exists, the command succeeds, and `{{GUIDE}} work-files-setup` passes without preparation: continue with the normal working-session flow for the user's request. Otherwise, continue to Step 3.

### Step 3 — Warn and ask

When the user says the repository must stay untouched, follow "Prepare through the companion" below instead of Steps 3 to 5.

End the turn on a message that explains the procedure: a branch created in the main worktree, preparation commits by the agent, a pull request the user must merge, and work waiting for that merge before the original request resumes.

Ask the user to approve this procedure and whether `.plans` must be shared through a work-files repository. If yes, ask for the repository URL. If no, `.plans` stays a plain directory. Wait for explicit approval.

### Step 4 — Prepare the project on a branch

On approval:

1. Complete `{{GUIDE}} work-files-setup` under the approved preparation, then run `{{ALIGNFIRST}} sync`. Run `{{ALIGNFIRST}} ticket --side` from PROJECT_PATH, write `{TICKET_DIR}A1-request.md` with the recorded request, then run `{{ALIGNFIRST}} sync`.
2. Create `{TICKET_ID}/alignfirst-setup` in the main worktree. This setup branch is the second main-worktree exception, next to new-project bootstrap.
3. Run `{{GUIDE}} code`. From PROJECT_PATH, delegate the preparation to the agent without a protocol: use the `alignfirst-setup-guide` skill and prepare the repository for an assistant, with the user's work-files repository decision and its URL. It must prepare `alignfirst.json`, effective plans and ignored `.local-wt/`, then run `{{ALIGNDEV}} project doctor` before `{{ALIGNFIRST}} workspace setup`, stopping on unhealthy inventory. Instruct the agent to commit and push the branch. The setup guide's rule against pushing addresses a human's laptop session, not this procedure.
4. Have the agent create a pull request.
5. End the turn on the PR link and state that work resumes once the PR is merged.

### Step 5 — After the merge

When the user reports the merge, or you observe it while checking the PR:

1. In the main worktree, switch back to the default branch, pull, and delete the local setup branch.
2. Install dependencies and build.
3. When the user chose the work-files repository, clone it under `{{PROJECTS_ROOT}}` when no clone exists there (the projects guide names the repository), then run `{{ALIGNFIRST}} plans setup {{PROJECTS_ROOT}}/<clone>` from PROJECT_PATH. Otherwise keep the prepared plans. Then verify with `{{GUIDE}} work-files-setup`.
4. Run `{{ALIGNDEV}} project doctor`. Stop when the inventory is unhealthy.
5. Prepare effective plans and ignored, untracked `.local-wt/`, then run `{{ALIGNFIRST}} workspace setup` on main. Delegate any separately required install/build/test work.
6. Continue with the normal working-session flow for the original request through `{{GUIDE}} project-workspace-setup`.

### Prepare through the companion

The preparation targets the project's companion directory. It writes nothing in the repository and creates no branch, commit or pull request.

1. Run `{{ALIGNFIRST}} companion register` from PROJECT_PATH. It keeps an existing registration and profile selection.
2. Complete `{{GUIDE}} work-files-setup` from PROJECT_PATH, starting at section 3: the Step 3 approval authorizes it, even when existing project plans are usable. It selects companion plans and leaves the existing work files in place without copying them.
3. Reread `{{ALIGNFIRST}} config --json`. Verify that `.plans` and every item to write resolve inside `companion.dir`. Missing `locations.alignfirst` must have a companion destination. `locations.developerInstructions` is null until a reference is configured: propose a suitable file and explicit `developerInstructions` setting under the onboarding authorization, then reread the report and verify its companion destination before creating the file. If an explicit item selection points a required write into the project, stop and resolve that selection with the user.
4. Unless the user already said, ask whether `.plans` must be shared through a work-files repository, and for its URL if so. Wait for the answer.
5. When the user chose the work-files repository, clone it under `{{PROJECTS_ROOT}}` when no clone exists there.
6. Run `{{GUIDE}} code`. From PROJECT_PATH, delegate the preparation to the agent without a protocol: use the `alignfirst-setup-guide` skill and follow its procedure "Set up a project through its companion" for an assistant, with the work-files clone path when there is one.
7. Run `{{ALIGNDEV}} project doctor`. Stop when the inventory is unhealthy.
8. Continue with the normal working-session flow for the original request through `{{GUIDE}} project-workspace-setup`.

## Remove a project

{{#thread}}
Removal requires the listed PROJECT_PATH selected before the thread opened or supplied by the user.
{{/thread}}
{{#app}}
Removal requires the listed PROJECT_PATH supplied by the user.
{{/app}}

1. Run and read `{{ALIGNDEV}} guide project`, then refresh `{{ALIGNDEV}} project list --json` and resolve the listed project at PROJECT_PATH. Run `{{ALIGNDEV}} project status <PROJECT_PATH>` and retain its companion directory when it reports one. Run `{{ALIGNFIRST}} developer-instructions` and read `{{ALIGNFIRST}} workspace --guide` deliberately from PROJECT_PATH for main's instructions.
2. List every linked worktree with its exact absolute path, through `{{ALIGNFIRST}} workspace list --json` from PROJECT_PATH. Add the exact PROJECT_PATH for the main worktree. Check every worktree, the main one included, for staged, unstaged, or untracked unignored changes. A dirty worktree stops the removal before anything is unregistered or deleted, and so does a missing or locked registration until it is resolved.
3. Show the user the complete linked-worktree path list and the main-worktree path. When the project status reports a companion directory, show it too and ask whether to keep or delete it. Wait for explicit confirmation of those exact paths, and for the answer about the companion directory.
4. Remove each confirmed linked workspace with `{{ALIGNFIRST}} workspace remove <exact-path>` yourself. For externally owned worktrees, run `{{ALIGNFIRST}} workspace teardown <exact-path>` and wait for their owner to delete them. No coding launch or plans preparation is needed for that. Stop immediately if any removal fails; keep the main worktree intact. After linked cleanup succeeds, run `{{ALIGNFIRST}} workspace teardown <PROJECT_PATH>` before unregistering the companion or deleting main. A teardown failure also stops removal and retains all remaining paths/state.
5. When the project status reports a companion, run `{{ALIGNFIRST}} companion unregister` from PROJECT_PATH. It removes the registry entry and keeps the companion directory. Add `--remove-dir --force` when the user chose to delete the companion directory.
6. Recheck that the main worktree is clean, then remove only the confirmed main-worktree directory at PROJECT_PATH. Leave every additional directory reported by the inventory untouched.
7. Refresh `{{ALIGNDEV}} project list --json`: the path must be absent from `projects`. Report any remaining workspace or filesystem discrepancy, and name the companion directory when it was kept.

Apply the host-specific and project-specific constraints read earlier throughout the sequence.
