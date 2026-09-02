# Create an AlignFirst Developer

An AlignFirst Developer is a dedicated Linux service account that receives work through Slack or Discord (OpenClaw) and delegates coding to Claude Code or Codex through `alcode`. This reference produces its **admin repository**: a private repository rendered from `assets/alignfirst-developer-template/`, holding the runbooks, the OpenClaw seed and the scripts that rebuild the server from scratch. Once the repository is published, its runbooks under `docs/installations/` take over.

## Topology

Three roles, named as the runbooks name them:

- **Support** — a coding-agent session on a laptop. Edits the admin repository, never executes on the server.
- **Operator** — a coding-agent session in the admin account `{{SERVER_ADMIN_USER}}` (sudo) on `{{SERVER_HOST}}`. Edits and executes. Holds the admin repository at `~{{SERVER_ADMIN_USER}}/{{ADMIN_REPOSITORY_NAME}}` and, with team plans, the plans clone beside it. Root steps are the operator's, through `sudo`.
- **Service account** — `{{SERVICE_USER}}`, no sudo, no inbound SSH, reached with `sudo -i -u {{SERVICE_USER}} -- <command>` (or `sudo -H -u {{SERVICE_USER}} bash -lc '…'` when the command defines a variable). Runs OpenClaw, the coding agent, `alcode`, `alproject`, rootless podman and the managed projects.

The service account never reads the admin repository. It works from a snapshot at `~{{SERVICE_USER}}/seed/`, an `rsync` of `infra/openclaw/` with `.env` included, refreshed by the root-owned maintenance wrapper before every protected change. The wrapper contains the service account, unlocks only named scopes, runs one command as that account, and restores hardening through an exit trap. From there:

- `~/.openclaw/` — `openclaw.json` (written by the seed through `openclaw config set`), `workspace/` (applied from `~/seed/workspace/`), `secrets/secrets.json` (every credential, referenced from `openclaw.json` as file SecretRefs), `.env` (the gateway env file, `CONTEXT7_API_KEY` only).
- `~/.config/environment.d/` — the non-secret variables `systemd --user` injects into the gateway and `~/.bash_profile` sources for login shells.
- The gateway unit, written by `openclaw gateway install`, enabled under lingering.
- `{{PROJECTS_ROOT}}` — the managed projects, the `alproject` registry and, with team plans, the service account's own clone of the plans repository (a repository, never a project).

Both accounts install the same selected coding agent. The admin account uses it as the operator with the project-local `sysadmin` skill; the service account uses it through `alcode`.

The human performs every interactive authentication and secret entry. Credentials never enter chat, files under version control, commands saved in shell history, or documentation.

## Rendering Inputs

### Options

- **Surface**: `slack` or `discord`.
- **Coding agent**: `claude-code` or `codex`.
- **Team plans repository**: yes or no. Yes when the team has one (see [plans-share-setup.md](plans-share-setup.md)).
- **Dev-server gateway**: yes or no, default yes. Skipping is not recommended: without the gateway there are no remote dev URLs, and `workspace setup --profile remote` is unusable in the managed projects.

Choose the model provider and model separately; the template favors no provider.

The agent **runtime** is fixed: every AlignFirst Developer uses OpenClaw's embedded runtime so the playbook can rely on OpenClaw's `exec` and `process` tools.

### Placeholder Vocabulary

`{{TOKEN}}` is replaced at render time. `<value>` in angle brackets is filled by the human at execution time (a Node version, a VPS IP, a secret) and never appears in this table. One execution-time value is a *name*, not a secret: `<DNS_CREDENTIAL_VARIABLE>` in the Caddyfile and in `09` is the environment variable the selected Caddy DNS module documents; the human writes it into `/etc/caddy/gateway.env` and into the `acme_dns` line.

| Token | Supplied by | Used by |
| --- | --- | --- |
| `{{ADMIN_REPOSITORY_NAME}}` | Operator | `package.json`, root files, `~/{{ADMIN_REPOSITORY_NAME}}` in the runbooks, the team plans folder |
| `{{ADMIN_REPOSITORY_URL}}` | Operator or git host | `02` (deploy key) |
| `{{SERVER_HOST}}` | Server administrator | hostname (`01`), deploy-key alias (`02`), overview, workspace files |
| `{{SERVER_ADMIN_USER}}` | Server administrator | admin account (`01`), operator commands, hardening ownership |
| `{{SERVICE_USER}}` | Server administrator | service account (`03`), every `sudo -i -u` command, the scripts |
| `{{DEVELOPER_NAME}}` | Operator | agent identity, bot name (`07`), secret provider id `{{DEVELOPER_NAME}}file` (lowercased by the seed; letters, digits, `-` and `_`, starting with a letter) |
| `{{PROJECTS_ROOT}}` | Operator | `.alproject.json`, `alproject-guide.md`, `backup.sh`, the project runbooks |
| `{{TIME_ZONE}}` | Operator | `timedatectl` (`01`), `USER.md`, overview |
| `{{GIT_HOSTS}}` | Operator | `03`, `05` (git-host CLIs), workspace `AGENTS.md`, coding-agent instructions |
| `{{RUNTIME_PROVIDER}}`, `{{RUNTIME_MODEL}}` | Operator | `.env.example`, `IDENTITY.md`, `04` (provider login) |
| `{{TEAM_NAME}}` | Operator | README, `IDENTITY.md`, `SOUL.md`, `USER.md` |
| `{{TEAM_MEMBERS}}` | Operator | `USER.md` |
| `{{PORT_RANGE_FIRST}}`, `{{PORT_RANGE_LAST}}` | Operator (suggested 28000–28599) | `.alproject.json`, `alproject-guide.md`, overview, workspace `AGENTS.md`, `09` |
| `{{SLACK_OWNER_ID}}`, `{{SLACK_CHANNEL_ID}}` | Slack administrator | `.env.example` (Slack overlay) |
| `{{DISCORD_OWNER_ID}}`, `{{DISCORD_GUILD_ID}}`, `{{DISCORD_CHANNEL_ID}}` | Discord administrator | `.env.example` (Discord overlay) |
| `{{DEV_DOMAIN}}` | Operator | `09`, Caddyfile, `authelia.yml`, `REMOTE_DEV_DOMAIN` in `common.conf`, overview, gotchas |
| `{{CADDY_DNS_MODULE}}`, `{{CADDY_DNS_PROVIDER}}` | Operator | `caddy add-package` (`09`), `acme_dns` (Caddyfile) |
| `{{PORT_RANGE_REGEX}}`, `{{DEV_DOMAIN_REGEX}}` | Derived | Caddyfile host regex |

`{{PROJECTS_ROOT}}` is written as the service account sees it: `~/projects` (the default) or an absolute path. `alproject` expands `~/` only, and the runbooks resolve the value through the service account's shell.

`{{TEAM_MEMBERS}}` is a Markdown list. Every member carries their role and the handle OpenClaw reports: the Slack member ID (`U…`) or the Discord `username`.

```markdown
- Alex Example — lead developer, Slack member ID `U0123456789`
```

The channel IDs are known before the bot exists (the channel, the server and the accounts pre-date the app). `04` lets the human correct them in `.env`.

The last two rows exist only when the gateway option is on. `{{PORT_RANGE_REGEX}}` is a regex matching exactly the integers `PORT_RANGE_FIRST..PORT_RANGE_LAST`: one digit class per position when the range allows it (`28000..28599` → `28[0-5][0-9]{2}`), otherwise an alternation of such classes (`6500..7700` → `6[5-9][0-9]{2}|7[0-6][0-9]{2}|7700`). `{{DEV_DOMAIN_REGEX}}` is `DEV_DOMAIN` with every `.` escaped as `\.`.

With team plans, also collect the plans repository URL and the two clone locations (beside the admin repository for the operator, under `{{PROJECTS_ROOT}}` for the service account). They are execution-time values of `02` and `add-project.md`, not tokens.

## Assemble the Admin Repository

On the operator's machine, from the installed skill directory:

1. Create an empty target directory outside the skill.
2. Copy the base with `cp -a` (the scripts' executable bits must survive): `cp -a assets/alignfirst-developer-template/base/. <target>/`.
3. Overlay exactly one surface: `cp -a assets/alignfirst-developer-template/variants/surfaces/<surface>/. <target>/`.
4. Overlay exactly one coding agent: `cp -a assets/alignfirst-developer-template/variants/coding-agents/<agent>/. <target>/`.
5. Gateway on: overlay `variants/options/dev-server-gateway/.` the same way, then delete the `DEV_SERVER_GATEWAY_SECTION` marker lines. Off: delete each marker block. From the target root, with `name` set to the marker:

   ```sh
   re="^[[:space:]]*(<!-- $name -->|# $name|// $name)[[:space:]]*$"
   # option on — delete the marker lines, keep the content
   grep -rlE "$re" . | while read -r f; do awk -v re="$re" '$0 !~ re' "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm "$f.tmp"; done
   # option off — delete the markers and the content between them
   grep -rlE "$re" . | while read -r f; do awk -v re="$re" '$0 ~ re { skip = !skip; next } !skip' "$f" | cat -s > "$f.tmp" && cat "$f.tmp" > "$f" && rm "$f.tmp"; done
   ```

6. Team plans on: delete the `TEAM_PLANS_SECTION` marker lines, then `npm pkg set 'scripts.plans:setup=plans-share setup --folder {{ADMIN_REPOSITORY_NAME}}' 'scripts.plans:sync=plans-share sync'` and `npm install -D @paleo/plans-share`. Off: delete the blocks.
7. Replace every `{{TOKEN}}`, after all overlays are present and the derived tokens are computed. `sed` handles single-line values; the member list needs the editor or a Node one-liner. Dotfiles (`.env.example`, `.alproject.json`) are part of the sweep.
8. `npm install`.
9. Install `sysadmin` project-locally, so the clone carries it: `npx -y skills add https://github.com/paleo/skills --yes --agent <claude-code|codex> --skill sysadmin </dev/null`. The CLI writes the skill under the agent's project skill directory (`.claude/skills/` or `.agents/skills/`) and the repository's own `skills-lock.json`; both are committed.
10. Run the audits below.
11. `git init -b main`, first commit `chore: initialize developer administration`, `git remote add origin {{ADMIN_REPOSITORY_URL}}`, push. The repository stays private.

Do not copy the alignfirst repository's `node_modules`, lock files or `skills-lock.json`. The rendered tree has no `variants/`.

The workspace `AGENTS.md` (`infra/openclaw/workspace/AGENTS.md`) carries no code-hosting, ticketing or merging policy. When the deployment provides a ticketing CLI or code-hosting policy, the operator replaces `## No ticket-system access` and adds the corresponding ticketing, code-hosting and merging sections, keeping the file under 12 KB.

## Audits Before the First Commit

From the target root:

```sh
rg -n --hidden -g '!node_modules' '\{\{[A-Z][A-Z0-9_]*\}\}' .
rg -n --hidden -g '!node_modules' 'TEAM_PLANS_SECTION|DEV_SERVER_GATEWAY_SECTION' .
for f in infra/openclaw/seed.sh infra/openclaw/seed/*.sh infra/openclaw/bin/*.sh; do bash -n "$f"; done
node --check scripts/workspace/workspace.mjs
node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(f, "utf8"))' infra/openclaw/alproject/.alproject.json package.json
npm run validate
```

Both `rg` searches must be empty. Add a search for every collected value that is not a token (the VPS IP, the plans repository URL, every secret): none may appear in the rendered tree.

## Deployment Lifecycle

Every runbook states its role and its position at the top. Human steps are marked `> **User action required.**`. Execution order:

1. `01-server-setup.md` — **human administrator**, on the fresh server: admin account, SSH key-only, firewall, Node, podman. Ends with the coding agent installed and logged in for the admin account, then a session of that agent in the clone takes over as the **operator**.
2. `02-admin-repository.md` — operator: deploy key (human registers it), clone, plans clone and `plans:setup` when enabled, `workspace setup`.
3. `03-toolchain.md` — service account created, npm prefix, the CLIs, the coding agent, git access (human: key registration or device code).
4. `05-openclaw-dependencies.md` — OS packages for the tools, git-host CLIs and their authentication (human), Chromium.
5. `07-channel.md`, platform part — **channel administrator** creates the app and collects the tokens and IDs for `.env`.
6. `04-openclaw.md` — human fills `.env`; snapshot, seed, workspace files, alproject files, lingering, `gateway install`, `podman.socket`; human: provider login when no API key, dashboard pairing through the SSH tunnel, reboot check from the laptop.
7. `08-coding-agent.md` — human authenticates the coding agent in the service account; skills, global instructions, verification.
8. `09-dev-server-gateway.md` when selected — human: DNS wildcard record and API token, Authelia secrets, gateway users.
9. `06-security-hardening.md` — last, because it locks what the others write.
10. `07-channel.md`, smoke test — operator, from the chat client.
11. `docs/operations/add-project.md` for each managed project. Prepare the project first through this skill's "Prepare a Project for an AlignFirst Developer" route, then `alproject register`.

The operator records each task in `.reports/`, committed. The operations runbooks own the rest: `configure-developer.md` (re-seed, secret rotation), `update-developer.md`, `update-workspace.md`, `recover-developer.md` (kill switch, backup, restore), `pair-dm-sender.md` (Discord).

## Linux Examples

The deployment invariants are distribution-independent: an unprivileged service account, rootless containers, user-owned configuration and secrets, explicit environment propagation, and a supervised user service.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

The generated runbooks contain the concrete Ubuntu commands. Keep root commands separate from service-account commands when adapting them.

## Completion Criteria

- The allowed channel routes work into one thread; a message elsewhere gets no reply.
- The coding agent runs every AlignFirst command through `alcode`, unattended.
- Every model route uses OpenClaw's embedded agent runtime.
- Managed-project workspaces are isolated; reports return to the originating thread.
- The gateway survives a reboot.
- Kill switch, failed-command maintenance cleanup, backup, update and recovery have each been exercised.
- `openclaw secrets audit` reports no plaintext, unresolved or shadowed reference; every credential in `openclaw.json` is a file SecretRef; the gateway environment holds no secret.
