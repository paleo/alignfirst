---
title: Troubleshooting
read_when:
  - the gateway, a channel, an app, the project routing or a delegation fails
---

# Troubleshooting

**Operator.** Read-only diagnostics first; keep secrets out of copied logs and reports.

## Gateway

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user status openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- journalctl --user -u openclaw-gateway --since today --no-pager
sudo -i -u {{SERVICE_USER}} -- openclaw config validate
sudo -i -u {{SERVICE_USER}} -- openclaw secrets audit
```

Run `secrets audit` from a login shell, as above: the file provider resolves from `secrets.json`, and a shell without `~/.bash_profile` lacks the environment the gateway has. A provider OAuth login appears as an informational legacy-residue finding; any other finding is a defect. Look at the first failing event, not the last restart.

## Project routing

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project list --json'
sudo -H -u {{SERVICE_USER}} bash -lc 'aligndev project status ~/projects/<repo> --json'
```

A project absent from the listing may not be a Git main worktree or may sit outside a marked projects directory. Invalid `alignfirst.json`/`alignfirst.jsonc` or workspace manifests are reported as inventory issues. Follow [add-project.md](operations/add-project.md). For moved worktrees, see [gotchas.md](gotchas.md#moving-a-project).

## Delegation

```sh
sudo -i -u {{SERVICE_USER}} -- aligndev guide code
sudo -i -u {{SERVICE_USER}} -- \
  openclaw config get models.providers.{{RUNTIME_PROVIDER}}.agentRuntime --json
# Expected: {"id":"openclaw"}
```

The agent runtime must be `openclaw`; another value changes the tool surface and breaks the
playbook's background delegation contract. Re-seed before investigating `aligndev code` itself.

The session file under the project's `.plans/<ticket>/_aligndev/` carries the exit reason. `exitReason: auth_required` means the coding agent's login expired: [08-coding-agent.md § Authenticate](installations/08-coding-agent.md#authenticate). A run that fails from the channel and succeeds from a login shell points at the gateway environment: compare `systemctl --user show-environment` with `env` ([04 § 9](installations/04-openclaw.md#9-environment-changes)).

## Profiles and Pi

Inspect the complete deployment inventory, not only the global `code.profile`:

```sh
sudo -H -u {{SERVICE_USER}} /usr/bin/node \
  /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json \
  /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo -i -u {{SERVICE_USER}} -- aligndev guide code --profile <profile>
```

Deployment requires explicit `code.profile`; singleton counts and per-agent `default: true` flags do not replace it. Duplicate true flags for one agent fail even with a named selection. Unknown or obsolete keys warn on stderr and are ignored, without rewriting settings. Retired direct launch fields and `code.defaultProfiles` have no effect; convert them manually, preserving profile names. Recognized invalid fields and deployment safety violations still fail. A registry-selected profile overrides the global selection; an explicit `--profile` overrides both. Run `alignfirst config --json` from the real project to inspect routing. A resume under another account must find the same native conversation there; no automatic migration occurs. Pi also requires its recorded real cwd.

For a Pi deployment, check the protected executable and supported system runtime without a model call:

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
settings="$HOME/.alignfirst/aligndev.settings.json"
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$settings" "$HOME" "$settings" >/dev/null
launch=$(jq -ce --arg name '<pi-profile>' '.code.profiles[$name] | select(.agent == "pi")' "$settings")
store=$(/usr/bin/node -e '
  const {resolve, dirname} = require("node:path");
  const value = JSON.parse(process.argv[1]).configDir;
  console.log(value === null ? resolve(process.env.HOME, ".pi/agent") :
    value.startsWith("~/") ? resolve(process.env.HOME, value.slice(2)) :
    resolve(dirname(process.argv[2]), value));' "$launch" "$settings")
if jq -e '.configDir == null' <<<"$launch" >/dev/null; then
  unset PI_CODING_AGENT_DIR
else
  export PI_CODING_AGENT_DIR="$store"
fi
command -v pi
PI_OFFLINE=1 pi --version
EOS
/usr/bin/node --version
```

Expect `/opt/{{SERVICE_USER}}/bin/pi`. A package/version/Node mismatch needs the reviewed package update followed by launcher regeneration after prefix hardening ([update-assistant.md](operations/update-assistant.md)). Do not invoke a second installer, fnm wrapper or unprotected package entry point as a workaround.

- **`auth_required` or refresh failure:** repeat the service-account routing in `08-coding-agent.md`: after login-shell initialization, unset `PI_CODING_AGENT_DIR` for null or set the resolved explicit path for a string. Reproduce the selected environment and cwd. Check its private `auth.json` ownership and adjacent lock permissions. The root/ancestor anchors should be root-owned, service-group writable and sticky (`1770`), not immutable. Preserve the approved same-UID auth exception; never thaw all native resources.
- **Trust prompt in a new worktree:** check the recorded approved parent, canonical worktree path and nearest saved decision in `<agent-dir>/trust.json`. Use `agent-config` maintenance for `/trust`, then restart Pi. Do not broaden trust silently or add `--approve`.
- **Settings/package write fails:** expected outside `agent-config` maintenance. Missing declared npm packages must be installed into that native store's managed npm directory. Symlinked anchors/non-package resources, escaping package links, padded paths, `file:` URLs and globs need reviewed concrete paths, not relaxed validation.
- **Missing `rg`/`fd`:** native `<agent-dir>/bin` is protected. Provision approved helpers there through `agent-config` or system PATH; do not grant runtime download writes or install Node there.
- **Subagent tool missing/duplicated:** check selected store, package identity and declarations, then install exactly one reviewed `@alignfirst/pi-subagent` with approval. Preserve user `agents/` profiles. OpenClaw needs no `pi-background` for delegation.

Pi `auth.json` may hold executable API-key commands. Another same-UID process can persist commands there with account privileges; permissions cannot distinguish that from credential renewal. Treat suspected persistence as an incident: contain the account, preserve a private mapped backup, review credentials/resources and recover through [recover-assistant.md](operations/recover-assistant.md), without copying secret contents into reports.

## Channel and thread flow

Run the smoke test of [07-channel.md](installations/07-channel.md). Check the allowlisted channel, the session binding and the thread destination before touching the playbook.

An off-topic answer, or `The tool run finished, but no final summary was produced. I did not repeat any completed actions.`, is usually not a model failure: the assistant chose silence on a turn that required a reply, and OpenClaw finalized the turn without its context. The journal names each case:

```sh
sudo journalctl _SYSTEMD_USER_UNIT=openclaw-gateway.service --since today --no-pager \
  | grep "running isolated finalization"
```

See [gotchas.md](gotchas.md#when-the-bot-may-stay-silent).

## App conversations

Setup and pairing: [use-the-apps.md](operations/use-the-apps.md).

- **The Serve URL times out from a team device** while `tailscale serve status` shows the route: the tailnet policy lacks the TCP 443 grant to the server.
- **A device connects but gets no answer** (`pairing required`): its request is pending. Approve it with `openclaw devices list` and `openclaw devices approve <request-id>`.
- **The Control UI reports `origin not allowed`**: the browser loaded it from an origin other than the Serve URL or the tunnel. Use the `https://…ts.net` URL; a different origin needs an entry in `gateway.controlUi.allowedOrigins`, set in `seed/common.sh`.
- **A conversation does not find its project**: it started on a folder that is not a listed project, or on the agent workspace with a request naming none. The assistant then resolves the request against the project inventory; check the project with `aligndev project list` as under "Project routing".

## Incidents

Record each one in `.reports/` with the commands run and the outcome, without secret values.
