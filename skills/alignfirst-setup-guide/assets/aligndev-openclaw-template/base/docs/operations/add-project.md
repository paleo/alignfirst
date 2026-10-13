---
title: Add a Project
read_when:
  - opening a repository to the assistant
  - a fresh clone's workspace setup or dev server fails
---

# Add a Project

**Operator.** Read the projects guide first. Every project is a direct child of `~/projects`, and the
clone uses the service account's git access from `03`.

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
run-file patches read `REMOTE_DEV_DOMAIN` from `environment.d/common.conf` at each dev start.
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
