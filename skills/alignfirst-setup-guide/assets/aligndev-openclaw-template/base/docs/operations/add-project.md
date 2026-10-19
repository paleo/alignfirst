---
title: Add a Project
read_when:
  - opening a repository to the assistant
  - a fresh clone's workspace setup or dev server fails
---

# Add a Project

**Operator.** Read the projects guide first. Every project is a direct child of `~/projects`, and the
clone uses the service account's git access from `03`. Before onboarding Pi, agree on a dedicated parent containing the clone and all future worktrees. Verify the workspace's actual layout against it. If the direct-child inventory layout prevents that boundary, arrange a compatible layout and discovery policy with the operator before cloning; do not silently trust all `~/projects`.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev guide project'
```

## Clone and prepare

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'git -C ~/projects clone <repository-url>'
```

Prepare the clone through the setup skill's **Prepare a Project for an Assistant** route.
It writes the bootstrap section and `.alignfirst.json`, and configures docmap, workspace, and
`DEVELOPERS.md`. It installs no AlignFirst skill.

<!-- TEAM_PLANS_SECTION -->
## Work-files repository

The service account keeps its work-files clone beside the projects. Clone it with the service account's
credentials when it is missing:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
if [ ! -d ~/projects/{{PLANS_CLONE_NAME}}/.git ]; then
  git -C ~/projects clone {{PLANS_REPOSITORY_URL}} {{PLANS_CLONE_NAME}}
fi
'
```

From the new project root, link the work-files folder configured in `.alignfirst.json`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
cd ~/projects/<repo>
alignfirst plans setup ~/projects/{{PLANS_CLONE_NAME}}
'
```

Without a usable link, `workspace setup` aborts on `alignfirst plans check`.
<!-- TEAM_PLANS_SECTION -->

## Select a provisioned profile

The deployment default is `code.profile`. To route this project elsewhere, edit the service account's `~/.alignfirst/companions/registry.json`, preserving existing entries, `dir` and `items`. A profile-only entry is valid:

```json
{
  "projects": {
    "~/projects/<repo>": { "aligndev": { "profile": "<provisioned-profile>" } }
  }
}
```

Use the real main-worktree path, not a linked worktree. A selection alone creates no companion and relocates no work files. The registry stays service-writable; it can choose any account provisioned in protected settings. It is routing, not account authorization.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && alignfirst config --json && aligndev guide code'
```

Confirm the effective profile, native directory and model without printing credentials. An explicit `--profile` overrides the registry. Changing a profile on resume must retain the native agent/session and selected account's conversation; it never copies sessions or silently starts another. Pi also requires the recorded real cwd.

### Pi parent trust

Repeat for every Pi store that may serve this project. Use its resolved path from the deployment inventory, not the operator's native store. Before hardening, start Pi directly as the service user in the approved parent; after hardening, use this interactive maintenance window:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance agent-config -- \
  env PI_CODING_AGENT_DIR=<resolved-service-agent-dir> \
  bash -c 'cd "$1" && exec pi' bash <approved-parent>
```

Run `/trust`, select **Trust**, then exit and restart Pi. From an immediate child, **Trust parent folder** is equivalent. Record the canonical approved parent in the onboarding report. Saved decisions live in `<agent-dir>/trust.json`; the nearest decision wins. Verify a future worktree beneath that parent after restart. Never add `--approve` or set `defaultProjectTrust: "always"`. Future project resources inherit the decision; trust is not an OS sandbox or protection against project modifications.

The maintenance window leaves the gateway stopped. Restart it only after successful policy restoration.

## Claim ports

A portless project needs no claim. For a dev-server with ports, calculate
`size = port names × expected concurrent workspaces`, then reserve the complete project block:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
aligndev project free-ports --size <size>
'
```

When the projects directory declares several ranges, inspect `aligndev guide project` and pass `--range <code>` for the project kind. Record the returned first and last ports as `portRange` in `.alignfirst.json` while preparing the clone, and as `first` and `last` of the `ports` group in the dev-server config. The dev-server checks the claim on every command.

## Check the inventory

After writing `.alignfirst.json` and before workspace setup, run the read-only inventory gate:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project doctor'
```

Stop when it reports an error. Resolve every configuration, discovery, and port conflict first.

## Set up the workspace

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm install && npm run workspace -- setup'
```

<!-- DEV_SERVER_GATEWAY_SECTION -->
The plain `workspace setup` above is enough for a project reachable through the gateway: its
run-file patches read `REMOTE_DEV_DOMAIN` from `environment.d/common.conf`.
<!-- DEV_SERVER_GATEWAY_SECTION -->

## Smoke test

Bring the dev server up, probe the URL it prints, bring it down, then inspect the discovered project:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run dev -- up'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run dev -- down'
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project status ~/projects/<repo>'
```

## Remove

Remove every linked workspace through the project's workspace command, then delete the clone. The
next listing no longer shows it:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run workspace -- remove <workspace>'
sudo -H -u {{SERVICE_USER}} bash -lc 'rm -rf ~/projects/<repo>'
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project list'
```
