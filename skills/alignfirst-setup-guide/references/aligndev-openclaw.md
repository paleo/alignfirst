# Create an Assistant

An assistant is a dedicated Linux service account. It receives work through Slack or Discord and the OpenClaw apps, and delegates coding to Claude Code, Codex or Pi through `aligndev code`. This reference produces its **admin repository**: a private repository rendered from `assets/aligndev-openclaw-template/`, holding the runbooks, the OpenClaw seed and the scripts that rebuild the server from scratch. Once the repository is published, its runbooks under `docs/installations/` take over.

## Deployment gate

The three overlays use explicit named profiles on both surfaces. Pi targets 1.3.0 and Node.js 22.19.0 or later. Its protected launcher executes the verified npm CLI with `/usr/bin/node`, preserving cwd, arguments, environment and project PATH. Packaged subagents reuse that Node through `process.execPath`. AlignDev's own minimum Node requirement remains separate.

**Approved Pi authentication exception:** `<agent-dir>/auth.json` stays private, service-owned and writable/replaceable, with adjacent locking, for normal native OAuth login and automatic credential/refresh-token renewal. It can also contain executable API-key commands. Any process under that account can persist such commands for later Pi execution. This is account-level persistence, not administrator privilege escalation; filesystem permissions cannot distinguish a refresh from another same-UID write. All other managed instructions, executable resources, settings/declarations, trust and launchers retain controlled-maintenance protection. Project trust is not a sandbox.

`deployment-profiles.mjs` inventories every provisioned child and optional quota store, deduplicating shared filesystem directories. Each coding profile and enabled explicit quota source must select `configDir: null` for native-default mode or a directory string for explicit mode; omission is invalid in deployments. Generated service defaults use null. This differs from ordinary developer setup, which omits the field to inherit the caller's directory selection. Like the CLI, it ignores unknown or obsolete settings keys with value-free warnings on stderr, including retired direct launch fields and `code.defaultProfiles`. Convert those fields manually to preserve their intent; they supply no legacy behavior. Recognized invalid fields, duplicate defaults and deployment safety violations still fail. Explicit valid `code.profile` remains mandatory. Custom stores must be isolated beneath the service home. Null inventories `.claude`, `.codex` or `.pi/agent` beneath that home; inventory output `configDir` remains an absolute filesystem path. Strings resolve against the deployed settings; `~/` uses the service home. A string naming the default path still sets the native variable and remains distinct from null. Symlinked roots, overlapping stores, native-directory env/unset conflicts and ambiguous native paths fail before mutation. Protected package trees allow only validated internal links. Do not treat the editable project registry as account authorization: all provisioned profiles are available to that account.

Native commands must read the original selection from the relevant named profile or quota settings: null unsets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR`; a string sets that variable to its resolved value. Apply this routing after login-shell initialization, including for authentication/status, configuration/trust, package installation, readiness and update/recovery. Filesystem operations use inventory paths in either mode. Profiles sharing a path may have different invocation modes; deduplicated stores do not encode that distinction. Explicit quota starts from its own service environment and directory selection, independently of coding-profile overrides.

Existing settings are never converted automatically. Confirm each string's intended mode with the operator before changing it. Upgrade the CLI, inventory/policy helpers, settings and matching runbooks together through controlled maintenance. On macOS, explicitly setting Claude's default path can select different Keychain credentials from leaving the variable unset; a mode change does not promise to preserve that login. Null resets directory routing only, not HOME, PATH or API-key precedence. No automatic login, credential transfer or Keychain migration is included.

The runbooks install the inventory/policy helpers root-owned under `/opt/{{SERVICE_USER}}/libexec`. Native anchors are root-owned service-group-writable sticky directories; individual resources and trees are protected without freezing the whole Pi directory. Managed alternate context names use neutral directory sentinels; empty reserved system-prompt files retain Pi's normal prompt. Credentials, locks, sessions and native caches remain mutable. Native `bin` helpers, npm/git packages, external managed targets and shared skills are inventoried too. Use concrete unpadded filesystem paths, not file URLs or external discovery globs.

OpenClaw remains the persistent parent. A Pi child needs no `pi-background`; production headless waiting has not shipped. The [maintainer map](../../../docs/aligndev-openclaw/aligndev-openclaw.md#pi-deployment-gate) describes offline evidence. OS ownership/immutable enforcement, real authentication/renewal, conversation, reboot and recovery acceptance must still be executed on the deployment host.

## Topology

Three roles, named as the runbooks name them:

- **Support** — a coding-agent session on a laptop. Edits the admin repository, never executes on the server.
- **Operator** — a coding-agent session in the admin account `{{SERVER_ADMIN_USER}}` (sudo) on `{{SERVER_HOST}}`. Edits and executes. Holds the admin repository at `~{{SERVER_ADMIN_USER}}/{{ADMIN_REPOSITORY_NAME}}` and, with a work-files repository, its clone under `~/projects`. Root steps are the operator's, through `sudo`.
- **Service account** — `{{SERVICE_USER}}`, no sudo, no inbound SSH, reached with `sudo -i -u {{SERVICE_USER}} -- <command>` (or `sudo -H -u {{SERVICE_USER}} bash -lc '…'` when the command defines a variable). Runs OpenClaw on fixed system Node, and runs the coding agent, `alignfirst`, `aligndev`, rootless podman and managed projects in fnm developer shells.

The service account never reads the admin repository. It works from a snapshot at `~{{SERVICE_USER}}/seed/`, an `rsync` of `infra/openclaw/` with `.env` included, refreshed by the root-owned maintenance wrapper before every protected change. The wrapper contains the service account, unlocks only named scopes, runs one command as that account, and restores hardening through an exit trap. From there:

- `~/.openclaw/` — `openclaw.json` (written by the seed through `openclaw config set`), `workspace/` (applied from `~/seed/workspace/`), `skills/` (admin-owned and empty, locked so the assistant cannot install skills), `secrets/secrets.json` (every credential, referenced from `openclaw.json` as file SecretRefs), `.env` (the gateway env file, `CONTEXT7_API_KEY` only), and `thread-handoff/state.sqlite` (the plugin's durable handoff state).
- `~/.agents/skills/` — the setup guide and `sharp-writing`, shared with the delegated coding agent.
- `/opt/{{SERVICE_USER}}/` — root-owned OpenClaw and project-shell launchers, fnm initialization, maintenance npm and runtime checks.
- `~/.local/share/fnm/` — service-owned project Node versions and the default LTS selection.
- `~/.npm-system-global/` — protected OpenClaw, coding-agent and admin CLI packages.
- `~/.config/environment.d/` — the non-secret variables `systemd --user` injects into the gateway and `~/.bash_profile` sources for login shells.
- `~/.alignfirst/` — locked by `06`. It holds `aligndev.settings.json`, the aligndev settings (platform, projects root, coding agent), installed by the seed. Its `companions/` stays service-owned: the assistant registers a project in the companion registry there with `alignfirst companion register`.
- The gateway unit, written by `openclaw gateway install`, enabled under lingering.
- `~/projects` — the managed projects, their `.alignfirst-projects.json` marker and, with a work-files repository, the service account's own clone of it (a repository, never a project).

Both accounts install the same selected coding agent. The admin account uses it as the operator with the project-local `sysadmin` skill; the service account uses it through `aligndev code`.

The human performs every interactive authentication and secret entry. Credentials never enter chat, files under version control, commands saved in shell history, or documentation.

## Rendering Inputs

### Options

- **Surface**: `slack` or `discord`. Every surface also serves the OpenClaw apps (web, desktop, mobile) through the same gateway.
- **Coding agent**: `claude-code`, `codex` or `pi`.
- **Pi child choices**, when selected: provider, native model ID, default/custom native directory, authentication method and optional quota source, independently of OpenClaw's runtime model. Offer installation of the independent `pi-subagent` package only with approval and a duplicate-tool audit. Quota `codex`/`claude` needs its own installed CLI and separately authenticated store; see [Optional quota setup for Pi](coding-agent-assistant.md#optional-quota-setup-for-pi).
- **Work-files repository**: yes or no. Yes when the team has one (see [plans-setup.md](plans-setup.md)).
- **Dev-server gateway**: yes or no, default yes. Skipping is not recommended: without the gateway there are no remote dev URLs, and the managed projects' public URLs fall back to localhost.

Choose the model provider and model separately; the template favors no provider.

The **assistant** is fixed: every deployment uses OpenClaw and its embedded runtime, so the playbook can rely on OpenClaw's `exec` and `process` tools.

### Placeholder Vocabulary

`{{TOKEN}}` is replaced at render time. `<value>` in angle brackets is filled by the human at execution time (a Node version, a VPS IP, a secret) and never appears in this table. One execution-time value is a *name*, not a secret: `<DNS_CREDENTIAL_VARIABLE>` in the Caddyfile and in `09` is the environment variable the selected Caddy DNS module documents; the human writes it into `/etc/caddy/gateway.env` and into the `acme_dns` line.

| Token | Supplied by | Used by |
| --- | --- | --- |
| `{{ADMIN_REPOSITORY_NAME}}` | Operator | `package.json`, root files, `~/{{ADMIN_REPOSITORY_NAME}}` in the runbooks, the work-files folder |
| `{{ADMIN_REPOSITORY_URL}}` | Operator or git host | `02` (deploy key) |
| `{{SERVER_HOST}}` | Server administrator | hostname (`01`), deploy-key alias (`02`), overview, workspace files |
| `{{SERVER_ADMIN_USER}}` | Server administrator | admin account (`01`), operator commands, hardening ownership |
| `{{SERVICE_USER}}` | Server administrator | service account (`03`), every `sudo -i -u` command, the scripts |
| `{{ASSISTANT_NAME}}` | Operator | assistant identity, bot name (`07`), secret provider id `{{ASSISTANT_NAME}}file` (lowercased by the seed; letters, digits, `-` and `_`, starting with a letter) |
| `{{TIME_ZONE}}` | Operator | `timedatectl` (`01`), `USER.md`, overview |
| `{{GIT_HOSTS}}` | Operator | `03`, `05` (git-host CLIs), workspace `AGENTS.md`, coding-agent instructions |
| `{{RUNTIME_PROVIDER}}`, `{{RUNTIME_MODEL}}` | Operator | `.env.example`, `IDENTITY.md`, `04` (OpenClaw provider login) |
| `{{PI_PROVIDER}}`, `{{PI_MODEL}}` | Operator, Pi only | Explicit child provider and native model ID; settings constructs `provider/model` |
| `{{PI_CONFIG_DIR_JSON}}` | Operator, Pi only | Raw JSON `null` for native defaults, or a JSON-encoded string for an isolated custom service-home directory |
| `{{PI_CONFIG_DIR_DISPLAY}}` | Derived, Pi only | Human-facing directory/mode description for Markdown, separate from the typed settings value |
| `{{PI_AUTH_METHOD}}` | Operator, Pi only | Non-secret description of the selected native OAuth/API-key/environment flow |
| `{{PI_QUOTA_JSON}}` | Operator, Pi only | Raw JSON object: `{"source":"none"}`, or a native source with its own null/string `configDir` |
| `{{TEAM_NAME}}` | Operator | README, `IDENTITY.md`, `SOUL.md`, `USER.md` |
| `{{TEAM_MEMBERS}}` | Operator | `USER.md` |
| `{{PORT_RANGE_FIRST}}`, `{{PORT_RANGE_LAST}}` | Operator (suggested 28000–28599) | `.alignfirst-projects.json`, overview, workspace `AGENTS.md`, `09` |
| `{{PLANS_REPOSITORY_URL}}` | Operator, work-files repository only | README, `02`, `add-project.md` |
| `{{PLANS_CLONE_NAME}}` | Operator, work-files repository only | `common.conf`, `02`, `add-project.md` |
| `{{PLANS_CLONE_NOTE}}` | Derived | projects marker |
| `{{SLACK_OWNER_ID}}`, `{{SLACK_CHANNEL_ID}}` | Slack administrator | `.env.example` (Slack overlay) |
| `{{DISCORD_OWNER_ID}}`, `{{DISCORD_GUILD_ID}}`, `{{DISCORD_CHANNEL_ID}}` | Discord administrator | `.env.example` (Discord overlay) |
| `{{DEV_DOMAIN}}` | Operator | `09`, Caddyfile, `authelia.yml`, `REMOTE_DEV_DOMAIN` in `common.conf`, overview, gotchas |
| `{{CADDY_DNS_MODULE}}`, `{{CADDY_DNS_PROVIDER}}` | Operator | `caddy add-package` (`09`), `acme_dns` (Caddyfile) |
| `{{PORT_RANGE_REGEX}}`, `{{DEV_DOMAIN_REGEX}}` | Derived | Caddyfile host regex |

`{{TEAM_MEMBERS}}` is a Markdown list. Every member carries their role and the handle OpenClaw reports: the Slack member ID (`U…`) or the Discord `username`.

```markdown
- Alex Example — lead developer, Slack member ID `U0123456789`
```

Pi values must be safely encoded for their destination; parse the rendered settings and syntax-check scripts after substitution. `PI_CONFIG_DIR_JSON` and `PI_QUOTA_JSON` are raw JSON values, substituted without surrounding quotes. For example, use `null` for Pi's default directory and `{"source":"claude","configDir":null}` for default Claude quota, or JSON-encode intentional custom paths. Disabled quota is only `{"source":"none"}`. `PI_CONFIG_DIR_DISPLAY` is Markdown text, never the settings value; the old `PI_CONFIG_DIR` placeholder is obsolete. Every enabled explicit quota source requires its own null/string selection. Authenticate under the same effective service environment and cwd, including HOME, PATH and API-key routing. Never render credentials. The child provider/model and quota account are independent of the OpenClaw runtime provider/model.

The channel IDs are known before the bot exists (the channel, the server and the accounts pre-date the app). `04` lets the human correct them in `.env`.

The last two rows exist only when the gateway option is on. `{{PORT_RANGE_REGEX}}` is a regex matching exactly the integers `PORT_RANGE_FIRST..PORT_RANGE_LAST`: one digit class per position when the range allows it (`28000..28599` → `28[0-5][0-9]{2}`), otherwise an alternation of such classes (`6500..7700` → `6[5-9][0-9]{2}|7[0-6][0-9]{2}|7700`). `{{DEV_DOMAIN_REGEX}}` is `DEV_DOMAIN` with every `.` escaped as `\.`.

With a work-files repository, collect `{{PLANS_REPOSITORY_URL}}` and `{{PLANS_CLONE_NAME}}` at render time. Both the operator and the service account clone it under `~/projects`; each account supplies its own credentials. `{{PLANS_CLONE_NOTE}}` is then a space followed by `The work-files clone at ~/projects/{{PLANS_CLONE_NAME}} is a repository, not a project.`; without one it is empty.

## Assemble the Admin Repository

On the operator's machine, from the installed skill directory:

1. Create an empty target directory outside the skill.
2. Copy the base with `cp -a` (the scripts' executable bits must survive): `cp -a assets/aligndev-openclaw-template/base/. <target>/`.
3. Overlay exactly one surface: `cp -a assets/aligndev-openclaw-template/variants/surfaces/<surface>/. <target>/`.
4. Overlay exactly one coding agent: `cp -a assets/aligndev-openclaw-template/variants/coding-agents/<agent>/. <target>/`.
5. Gateway on: overlay `variants/options/dev-server-gateway/.` the same way, then delete the `DEV_SERVER_GATEWAY_SECTION` marker lines. Off: delete each marker block. From the target root, with `name` set to the marker:

   ```sh
   re="^[[:space:]]*(<!-- $name -->|# $name|// $name)[[:space:]]*$"
   # option on — delete the marker lines, keep the content
   grep -rlE "$re" . | while read -r f; do awk -v re="$re" '$0 !~ re' "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm "$f.tmp"; done
   # option off — delete the markers and the content between them
   grep -rlE "$re" . | while read -r f; do awk -v re="$re" '$0 ~ re { skip = !skip; next } !skip' "$f" | cat -s > "$f.tmp" && cat "$f.tmp" > "$f" && rm "$f.tmp"; done
   ```

6. Work-files repository on: delete the `TEAM_PLANS_SECTION` marker lines. The guarded block in `.alignfirst.json` writes `plans.repositoryFolder` as `{{ADMIN_REPOSITORY_NAME}}`. Off: delete each block, including that field.
7. Replace every `{{TOKEN}}`, after all overlays are present and the derived tokens are computed. `sed` handles single-line values; the member list needs the editor or a Node one-liner. Dotfiles (`.env.example`, `.alignfirst.json`, `.alignfirst-projects.json`) are part of the sweep.
8. `npm install`.
9. Install `sysadmin` project-locally, so the clone carries it: `npx -y skills add https://github.com/paleo/skills --yes --agent <claude-code|codex|pi> --skill sysadmin </dev/null`. The CLI writes the skill under the agent's project skill directory (`.claude/skills/` for Claude, `.agents/skills/` for Codex/Pi) and the repository's own `skills-lock.json`; both are committed. The verified `skills@1.7.2` Pi target uses `.agents/skills/`; recheck the installed CLI contract when upgrading.
10. Run the audits below.
11. `git init -b main`, first commit `chore: initialize assistant administration`, `git remote add origin {{ADMIN_REPOSITORY_URL}}`, push. The repository stays private.

Do not copy the alignfirst repository's `node_modules`, lock files or `skills-lock.json`. The rendered tree has no `variants/`.

The workspace `AGENTS.md` (`infra/openclaw/workspace/AGENTS.md`) carries one code-hosting policy: `## Pull requests` creates every PR as a draft. It carries no ticketing or merging policy. The operator adapts `## Pull requests` to the team's preference. When the deployment provides a ticketing CLI or a merging policy, the operator replaces `## No ticket-system access` and adds the corresponding ticketing and merging sections, keeping the file under 12 KB.

## Audits Before the First Commit

From the target root:

```sh
rg -n --hidden -g '!node_modules' '\{\{[A-Z][A-Z0-9_]*\}\}' .
rg -n --hidden -g '!node_modules' 'TEAM_PLANS_SECTION|DEV_SERVER_GATEWAY_SECTION' .
for f in infra/openclaw/seed.sh infra/openclaw/seed/*.sh infra/openclaw/bin/*.sh infra/openclaw/bin/openclaw infra/openclaw/node-runtime/project-shell infra/openclaw/node-runtime/init.bash infra/openclaw/node-runtime/admin-npm infra/openclaw/node-runtime/check-project-runtimes.sh; do bash -n "$f"; done
node --check scripts/workspace/workspace.mjs
node --check infra/openclaw/deployment-profiles.mjs
node --check infra/openclaw/deployment-policy.mjs
# Pi overlay: also bash -n node-runtime/install-pi-launcher.sh and
# node --check node-runtime/pi-launcher.mjs under infra/openclaw/.
node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(f, "utf8"))' infra/openclaw/projects/.alignfirst-projects.json infra/openclaw/aligndev.settings.json .alignfirst.json package.json
npm run validate
```

Both `rg` searches must be empty. On the service host, validate the inventory with `node infra/openclaw/deployment-profiles.mjs infra/openclaw/aligndev.settings.json /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json`. The seed then validates every installed profile through an explicit `aligndev guide code --profile <name> --channel app`, independent of the seed cwd's project selection. All provisioned profiles are available to the service account: the editable project registry selects routes, not account authorization. Add a search for every collected value that is not a token (the VPS IP, the work-files repository URL, every secret): none may appear in the rendered tree.

## Deployment Lifecycle

Every runbook states its role and its position at the top. Human steps are marked `> **User action required.**`. Execution order:

1. `01-server-setup.md` — **human administrator**, on the fresh server: admin account, SSH key-only, firewall, Node, podman. Ends with the coding agent installed and logged in for the admin account, then a session of that agent in the clone takes over as the **operator**.
2. `02-admin-repository.md` — operator: deploy key (human registers it), clone, work-files clone and `alignfirst plans setup` when enabled, `workspace setup`.
3. `03-toolchain.md` — service account created, npm prefix, the CLIs, the coding agent, git access (human: key registration or device code).
4. `05-openclaw-dependencies.md` — OS packages for the tools, git-host CLIs and their authentication (human), Chromium and its AppArmor user-namespace profile.
5. `07-channel.md`, platform part — **channel administrator** creates the app and collects the tokens and IDs for `.env`.
6. `04-openclaw.md` — human fills `.env`; snapshot, seed, workspace files, the projects marker, lingering, `gateway install`, `podman.socket`; human: provider login when no API key, dashboard pairing through the SSH tunnel, reboot check from the laptop.
7. `08-coding-agent.md` — human authenticates the coding agent in the service account; skills, global instructions, verification.
8. `09-dev-server-gateway.md` when selected — human: DNS wildcard record and API token, Authelia secrets, gateway users.
9. `06-security-hardening.md` — last, because it locks what the others write.
10. `07-channel.md`, smoke test — operator, from the chat client.
11. `docs/operations/use-the-apps.md` — opens the apps to the team. Human: Tailscale login and tailnet settings; operator: Tailscale Serve through a re-seed, then each device's approval.
12. `docs/operations/add-project.md` for each managed project. Prepare the project first through this skill's "Prepare a Project for an Assistant" route, which writes `.alignfirst.json`. Project discovery then needs no registration step.

The operator records each task in `.reports/`, committed. The operations runbooks own the rest: `use-the-apps.md` (devices), `configure-assistant.md` (re-seed, secret rotation), `update-assistant.md`, `update-workspace.md`, `recover-assistant.md` (kill switch, backup, restore), `pair-dm-sender.md` (Discord).

The seed carries only the settings the deployment decided, and follows an OpenClaw default when a release changes it. `docs/configuration.md` states the rule and `update-assistant.md` applies it at each core bump.

The `assistant` files are named after the role, not the instance. An operator who prefers the assistant's own name renames them after rendering: `update-{{ASSISTANT_NAME}}.md`, `{{ASSISTANT_NAME}}-kill.sh`. Update the links and the `install` commands in the same pass.

## Linux Examples

The deployment invariants are distribution-independent: an unprivileged service account, rootless containers, user-owned configuration and secrets, explicit environment propagation, and a supervised user service.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

The generated runbooks contain the concrete Ubuntu commands. Keep root commands separate from service-account commands when adapting them.

## Completion Criteria

- The allowed channel routes work into one thread; a message elsewhere gets no reply.
- The coding agent runs every AlignFirst command through `aligndev code`, unattended.
- Every model route uses OpenClaw's embedded agent runtime.
- `alignfirst-service` is loaded as an external plugin, `thread_handoff` is allowed, Slack effective
  `replyToMode` is `off` or Discord channel `autoThread` is `false`, and a complete request starts in
  its regular thread session through a reply run the plugin dispatches, without a human nudge; for
  the wake command, the `openclaw` CLI runs as the service user from the gateway host.
- Managed-project workspaces are isolated; reports return to the originating thread, and a conversation's report returns to that conversation.
- The operator approves every app device, and only team members' devices; a tailnet identity alone grants no access, and no node capability is approved.
- The runtime harness passes directly and through a private gateway agent turn; each exec shell selects the project runtime independently of OpenClaw's startup snapshot.
- The gateway survives a reboot.
- Kill switch, failed-command maintenance cleanup, backup, update and recovery have each been exercised.
- `openclaw secrets audit` reports no plaintext, unresolved or shadowed reference and no store residue; every credential in `openclaw.json` is a file SecretRef; the gateway environment holds no secret.
