---
title: Troubleshooting
read_when:
  - the gateway, a channel, the project routing or a delegation fails
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
sudo -i -u {{SERVICE_USER}} -- alproject list --json
sudo -i -u {{SERVICE_USER}} -- alproject status <repo> --json
```

`unregistered on filesystem` needs [add-project.md](operations/add-project.md); `registered but missing from filesystem` needs the clone restored or a deliberate `unregister`. Never edit the registry by hand, except for the moved-project case in [gotchas.md](gotchas.md#moving-a-project-breaks-its-workspace-registry).

## Delegation

```sh
sudo -i -u {{SERVICE_USER}} -- alcode --guide
sudo -i -u {{SERVICE_USER}} -- \
  openclaw config get models.providers.{{RUNTIME_PROVIDER}}.agentRuntime --json
# Expected: {"id":"openclaw"}
```

The agent runtime must be `openclaw`; another value changes the tool surface and breaks the
playbook's background delegation contract. Re-seed before investigating alcode itself.

The session file under the project's `.plans/<ticket>/_alcode/` carries the exit reason. `exitReason: auth_required` means the coding agent's login expired: [08-coding-agent.md § Authenticate](installations/08-coding-agent.md#authenticate). A run that fails from the channel and succeeds from a login shell points at the gateway environment: compare `systemctl --user show-environment` with `env` ([04 § 9](installations/04-openclaw.md#9-environment-changes)).

## Channel and thread flow

Run the smoke test of [07-channel.md](installations/07-channel.md). Check the allowlisted channel, the session binding and the thread destination before touching the playbook.

## Incidents

Record each one in `.reports/` with the commands run and the outcome, without secret values.
