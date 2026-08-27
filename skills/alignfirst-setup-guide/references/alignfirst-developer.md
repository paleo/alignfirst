# Create an AlignFirst Developer

Create a dedicated Linux service that receives work through Slack or Discord and delegates coding to
Claude Code or Codex. The OpenClaw runtime model, communication surface, and delegated coding agent
are independent choices.

## Execution Roles

Every command in the generated runbooks carries one role:

- **Operator machine**: creates and maintains the admin repository and connects to the server.
- **Privileged server administrator**: installs system packages, creates the service account, and
  configures host security. This role does not run OpenClaw day to day.
- **Service user**: owns OpenClaw, coding-agent authentication, projects, and user-level services. The
  account is unprivileged and has no sudo access.
- **Managed project**: repository-specific preparation, workspace setup, and registration commands.

The human performs every interactive authentication and secret-entry step. Never paste credentials
into chat, tracked files, commands saved in shell history, or documentation.

## Collect Deployment Values

Inspect the operator machine, chosen git hosts, and target server. Record every value before rendering
the template. Do not infer a value that controls identity, access, networking, or billing.

Choose one Slack or Discord surface and one Claude Code or Codex delegated agent. Choose and
authenticate the OpenClaw runtime provider separately. Decide whether a team plans repository exists.

### Placeholder Vocabulary

Replace each token after applying both selected overlays. Tokens are concrete non-secret values.

| Token | Supplied by | Secret |
| --- | --- | --- |
| `{{ADMIN_REPOSITORY_NAME}}` | Operator | No |
| `{{ADMIN_REPOSITORY_URL}}` | Operator or git host | No |
| `{{SERVER_HOST}}` | Server administrator | No |
| `{{SERVER_ADMIN_USER}}` | Server administrator | No |
| `{{SERVICE_USER}}` | Server administrator | No |
| `{{DEVELOPER_NAME}}` | Operator | No |
| `{{PROJECTS_ROOT}}` | Operator and service user | No |
| `{{TIME_ZONE}}` | Operator | No |
| `{{GIT_HOSTS}}` | Operator | No |
| `{{RUNTIME_PROVIDER}}` | Operator | No |
| `{{RUNTIME_MODEL}}` | Operator | No |
| `{{SLACK_WORKSPACE_ID}}` | Slack administrator | No |
| `{{SLACK_CHANNEL_ID}}` | Slack administrator | No |
| `{{DISCORD_GUILD_ID}}` | Discord administrator | No |
| `{{DISCORD_CHANNEL_ID}}` | Discord administrator | No |

Tokens and API keys are different. Templates may name secret environment variables and OpenClaw
SecretRefs, but never contain the values. Remove the unused surface tokens with the unused overlay.

When team plans are enabled, also collect the repository URL, clone location, and admin-repository
folder name. Add them through the plans-share setup operation; they are not unconditional template
tokens.

## Assemble the Admin Repository

Run these steps on the operator machine from the installed setup skill directory:

1. Create an empty target directory outside the setup skill.
2. Copy `assets/alignfirst-developer-template/base/.` into it.
3. Overlay exactly one directory from
   `assets/alignfirst-developer-template/variants/surfaces/`.
4. Overlay exactly one directory from
   `assets/alignfirst-developer-template/variants/coding-agents/`.
5. Copy `assets/workspace.mjs` to `scripts/workspace/workspace.mjs`.
6. Adapt that wrapper to the portless admin repository:
   - remove `devServerScript`, `ports`, and all dev-server or infrastructure callbacks;
   - keep `sharedDirs: [".local", ".plans"]` and `runtimeDir: ".local-wt"`;
   - seed only gitignored files the admin repository actually needs;
   - make `finalizeWorkspace` run `npm install` idempotently before any later check;
   - when plans-share is enabled, make `preSetup` run
     `npx --no plans-share check` in the main worktree only;
   - remove all `ADAPT` and example scaffolding.
7. Replace every token only after both overlays are present.
8. Remove the `TEAM_PLANS_SECTION` markers. If team plans are enabled, install
   `@paleo/plans-share`, add `plans:setup` and `plans:sync` scripts, add the documented `AGENTS.md`
   and `DEVELOPERS.md` sections, and retain the main-worktree `preSetup` check.
9. Initialize git, install dependencies, and install project and global skills through `npx skills`.
   Let that CLI create canonical skill directories and lock state.

Do not copy source-repository `node_modules`, package lock state, or `skills-lock.json`. The rendered
repository must not contain `variants/`.

Before the first commit, require these audits from the target root:

```sh
rg -n '\{\{[A-Z][A-Z0-9_]*\}\}' .
rg -n 'ADAPT|TEAM_PLANS_SECTION' .
node --check scripts/workspace/workspace.mjs
npm run docmap -- --check
```

Both searches must return no matches. Parse every JSON file and run `bash -n` on every shell script.

## Deployment Lifecycle

Follow the generated runbooks in order. Each document states its execution role and human-owned
steps.

1. **Inspect and decide**: confirm the collected values, selected surface, delegated agent, runtime
   provider/model, git hosts, and team plans choice.
2. **Create the repository**: render the template, audit it, initialize git, and publish the private
   admin repository.
3. **Prepare the Linux host**: follow `docs/installations/01-server-setup.md` as the privileged
   administrator. Create the dedicated service user without sudo access.
4. **Clone the admin repository**: follow `docs/installations/02-admin-repository.md` as the service
   user.
5. **Install the toolchain**: follow `docs/installations/03-toolchain.md` for Node, rootless
   containers, OpenClaw, `alcode`, `alproject`, and git-host CLIs.
6. **Install OpenClaw**: follow `docs/installations/04-openclaw.md`. Authenticate the independently
   selected runtime provider as a human.
7. **Configure project discovery**: follow `docs/installations/05-project-registry.md` and validate
   `alproject list --json`.
8. **Install skills**: follow `docs/installations/06-skills.md`. Install the OpenClaw playbook for the
   runtime role, the AlignFirst content and command skills for the delegated coding agent, and the
   project-local `sysadmin` skill. Install and retain `alignfirst-setup-guide` globally for the
   selected delegated agent under the service user.
9. **Configure the surface**: follow `docs/installations/07-channel.md`. Enter channel tokens and
   identifiers as a human.
10. **Configure the delegated agent**: follow `docs/installations/08-coding-agent.md`. Authenticate
    interactively and set the `alcode` selector independently from the runtime provider.
11. **Seed and validate configuration**: derive configuration from the installed OpenClaw defaults,
    apply common and selected modules, create SecretRefs, and validate the result.
12. **Install the service and workspace**: install the user-level service, enable lingering when
    available, apply the version-controlled workspace, and verify hardening boundaries.
13. **Prepare managed projects**: in each project, use this setup skill's complete project-preparation
    route before `alproject register`. Include AlignFirst skills, conditional plans-share, docmap,
    workspace, and a project-specific `DEVELOPERS.md`.
14. **Verify end to end**: run the selected channel smoke test, project selection, thread flow,
    workspace creation, read-only protocol delegation, result delivery, restart, kill switch, backup,
    and recovery checks.
15. **Hand off operations**: follow the generated update, recovery, and troubleshooting runbooks.
    Record ownership for routine upgrades, backup review, kill-switch use, and incidents.

## Linux Examples

The deployment invariants are distribution-independent: an unprivileged service account, rootless
containers, user-owned configuration and secrets, explicit environment propagation, and a supervised
user service.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and
> service-manager commands for another Linux server when needed.

The generated server and toolchain runbooks contain the concrete Ubuntu commands. Keep privileged
administrator commands separate from service-user commands when adapting them.

## Completion Criteria

The deployment is complete when the allowed channel routes work into one thread, the selected agent
can execute every AlignFirst command through `alcode`, managed-project workspaces are isolated, reports
return to the originating thread, restarts preserve operation, and the documented kill switch, backup,
update, and recovery procedures have been exercised.
