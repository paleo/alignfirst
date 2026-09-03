---
title: Add a Project
read_when:
  - opening a repository to the developer
  - a fresh clone's workspace setup or dev server fails
---

# Add a Project

**Operator.** Read the projects guide first. Every project is a direct child of `~/projects`, and the
clone uses the service account's git access from `03`.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'alcode projects --guide --root ~/projects'
```

## Clone and prepare

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'git -C ~/projects clone <repository-url>'
```

Prepare the clone through the setup skill's **Prepare a Project for an AlignFirst Developer** route.
It installs the CLI prerequisite and skills, writes `.alignfirst.json`, and configures docmap,
workspace, and `DEVELOPERS.md`.

<!-- TEAM_PLANS_SECTION -->
## Team plans

The service account keeps its plans clone beside the projects. Clone it with the service account's
credentials when it is missing:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
if [ ! -d ~/projects/{{PLANS_CLONE_NAME}}/.git ]; then
  git -C ~/projects clone {{PLANS_REPOSITORY_URL}} {{PLANS_CLONE_NAME}}
fi
'
```

From the new project root, link the plans folder configured in `.alignfirst.json`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
cd ~/projects/<repo>
alignfirst plans setup ~/projects/{{PLANS_CLONE_NAME}}
'
```

Without a usable link, `workspace setup` aborts on `alignfirst plans check`.
<!-- TEAM_PLANS_SECTION -->

## Claim ports

A portless project needs no claim. For a wrapper with ports, calculate
`size = perWorkspace × maxWorkspaces`, then reserve the complete project block:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
alcode projects free-ports --root ~/projects --size <size>
'
```

Use the returned first and last ports while preparing the clone:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '
cd ~/projects/<repo>
alignfirst setup --port-range <first>-<last> <other-setup-options>
'
```

When setup already created `.alignfirst.json`, edit its `portRange` to the returned block. The
workspace kernel checks the claim against its port scheme on every command. Confirm discovery:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'alcode projects list --root ~/projects'
```

## Set up the workspace

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm install && npm run workspace -- setup'
```

<!-- DEV_SERVER_GATEWAY_SECTION -->
A project reachable through the gateway uses the `remote` profile instead. It reads
`REMOTE_DEV_DOMAIN` from `environment.d/common.conf`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run workspace -- setup --profile remote'
```
<!-- DEV_SERVER_GATEWAY_SECTION -->

## Smoke test

Bring the dev server up, probe the URL it prints, bring it down, then inspect the discovered project:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run dev -- up'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run dev -- down'
sudo -H -u {{SERVICE_USER}} bash -lc 'alcode projects status <repo> --root ~/projects'
```

## Remove

Remove every linked workspace through the project's workspace command, then delete the clone. The
next listing no longer shows it:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd ~/projects/<repo> && npm run workspace -- remove <workspace>'
sudo -H -u {{SERVICE_USER}} bash -lc 'rm -rf ~/projects/<repo>'
sudo -H -u {{SERVICE_USER}} bash -lc 'alcode projects list --root ~/projects'
```
