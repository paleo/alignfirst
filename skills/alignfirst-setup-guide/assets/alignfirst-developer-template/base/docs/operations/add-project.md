---
title: Add a Project
read_when:
  - opening a repository to the developer
  - a fresh clone's workspace setup or dev server fails
---

# Add a Project

**Operator.** Run `alproject --guide` first: every project is a direct child of `{{PROJECTS_ROOT}}`, and the rendered `alproject-guide.md` describes the parent. The clone uses the service account's git access from `03`, so the repository must grant that account write access.

## Clone and prepare

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'git -C {{PROJECTS_ROOT}} clone <repository-url>'
```

A repository that lacks the AlignFirst Developer contract (AlignFirst skills, docmap, the workspace system, a `DEVELOPERS.md`) is prepared through the `alignfirst-setup-guide` skill, from a coding-agent session in the clone.

<!-- TEAM_PLANS_SECTION -->
## Team plans

The service account has its own clone of the team plans repository, under `{{PROJECTS_ROOT}}` beside the projects. It is a repository, not a project: it stays unregistered, as the rendered `alproject-guide.md` says. Clone it once:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'git -C {{PROJECTS_ROOT}} clone <plans-repository-url>'
```

Link each new project to it. Without this, `workspace setup` aborts on `plans-share check`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd {{PROJECTS_ROOT}}/<repo> && npm install && npm run plans:setup -- {{PROJECTS_ROOT}}/<plans-clone>'
```
<!-- TEAM_PLANS_SECTION -->

## Register

A portless project registers with the bare command. When the project's wrapper declares ports, pass its `perWorkspace` and `maxWorkspaces`; an existing project claims its configured base, a new one omits `--base-port` and writes the returned base into its workspace configuration:

```sh
sudo -i -u {{SERVICE_USER}} -- alproject register <repo>
sudo -i -u {{SERVICE_USER}} -- alproject register <repo> --ports-per-workspace <n> --max-workspaces <n> --base-port <base-port>
```

Registration fails without changing the registry when the range is unavailable. Moving a registered project costs more than a `mv` — see [gotchas.md](../gotchas.md#moving-a-project-breaks-its-workspace-registry).

## Set up the workspace

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd {{PROJECTS_ROOT}}/<repo> && npm install && npm run workspace -- setup'
```

<!-- DEV_SERVER_GATEWAY_SECTION -->
A project reachable through the gateway uses the `remote` profile instead. It reads `REMOTE_DEV_DOMAIN` from `environment.d/common.conf`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd {{PROJECTS_ROOT}}/<repo> && npm run workspace -- setup --profile remote'
```
<!-- DEV_SERVER_GATEWAY_SECTION -->

## Smoke test

Bring the dev server up, probe the URL it prints, bring it down:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'cd {{PROJECTS_ROOT}}/<repo> && npm run dev -- up'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/
sudo -H -u {{SERVICE_USER}} bash -lc 'cd {{PROJECTS_ROOT}}/<repo> && npm run dev -- down'
sudo -i -u {{SERVICE_USER}} -- alproject status <repo>
```

## Remove

```sh
sudo -i -u {{SERVICE_USER}} -- alproject unregister <repo>
```

The clone stays on disk until deleted by hand; remove its workspaces first (`npm run workspace -- remove`), so no container or dev server is stranded.
