# A Coding Agent as the Assistant

Claude Code, Codex or a persistent Pi session can act as the AlignFirst assistant on one project: the repository where its session starts. It follows the `aligndev` playbook and delegates through `aligndev code`. Parent host and selected child are independent; no OpenClaw deployment is needed.

Supported systems: Linux and macOS, and Windows through WSL.

## 1. Prepare the project

The project needs a `.plans` directory, in its repository or in its companion directory. Follow [AlignFirst setup](alignfirst-skills-setup.md#configure-the-project), with [plans-setup.md](plans-setup.md) for a work-files repository, or [companion-setup.md](companion-setup.md) for a repository that must stay untouched.

[Prepare a Project for an Assistant](../SKILL.md#prepare-a-project-for-an-assistant) applies: skip the command skills and the global bootstrap line. It also describes the content of `DEVELOPERS.md`, which the assistant reads when it exists, else the `README.md` at the repository root.

## 2. Configure `aligndev` (recommended)

Without settings, `aligndev` launches the same agent as the one that runs the assistant, detected from its environment. Settings make the choice explicit, which matters when the detection is ambiguous, for example Codex started in a VS Code terminal where the Claude Code extension also sets its variable. Write `~/.alignfirst/aligndev.settings.json`:

```json
{
  "code": { "agent": "claude" }
}
```

`code.agent` selects the child: `claude`, `codex` or `pi`. It never selects the parent's launch tool. For Pi, prefer a native `provider/model` selector, optionally with a thinking suffix. Without a nonempty `code.models`, any nonblank native selector is accepted. New sessions use `code.defaultModel`, else Pi's default; resumes keep their recorded model and require the original worktree. Pi account quota is unsupported. The [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#configuration) documents the optional `code` keys.

Check whether the developer's shell exports `ANTHROPIC_API_KEY` (Claude Code) or `CODEX_API_KEY` (Codex); check the names only, never print the values. The agent runs non-interactively (`claude -p`, `codex exec`), where such a key overrides the subscription login, even when the developer's own session declined it. When the developer wants the agent on their subscription, list the key in `code.unset`:

```json
{
  "code": { "agent": "claude", "unset": ["ANTHROPIC_API_KEY"] }
}
```

For a Pi child, start `pi` under the account/configuration the child will use and run `/login <provider>`, or configure the provider's credentials. Pi uses its native credential precedence; do not assume the Claude/Codex environment-key rules above apply. Inspect only credential-variable names, never values. Saved project trust must cover the execution directory and required project resources; do not force `--approve` to bypass missing trust.

## 3. Install the skill globally

The `aligndev` skill goes in the developer's global agent configuration:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes --skill aligndev </dev/null
```

Add `--agent claude-code`, `--agent codex` or `--agent pi` to target one host. The verified `skills@1.7.2` Pi target installs globally under `~/.agents/skills/`, which Pi discovers. Check the installer's current help/source when upgrading rather than assuming its layout. Restart the agent after installation.

Without a skill, add the "Aligndev" section from the [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#without-a-skill) to the developer's global agent instructions instead. The user then asks the session to work with aligndev.

## 4. Install Pi tools for the requested roles

The skill supplies instructions only. Neither extension installs it, the CLI, profiles or the other extension. Obtain approval before global installation:

- **Pi parent assistant:** `pi install npm:@alignfirst/pi-background`. This generic tool runs the ordinary quoted `aligndev code` command; the playbook supplies `--quiet`, unique run identity, result retrieval and workflow decisions.
- **Pi coding child:** `pi install npm:@alignfirst/pi-subagent` in that child's environment for isolated plan/review assignments. The assistant still delegates through `aligndev code`, never directly through `subagent`.

Install both when both roles use Pi. Before installing the packaged subagent replacement, identify any existing extension registering `subagent` and obtain explicit approval to disable it through `pi config`. Do not overwrite the local extension or profiles, or load both implementations. Reload after installation; `/reload` cancels active jobs and subagents.

These packages target Pi 1.3.0 and require Node.js 22.19 or later. A Pi assistant must remain alive after acknowledging a launch; print/JSON one-shot processes do not qualify. Missing `background` capability is a setup blocker, not permission to block on bash or detach with `&`. Manual compaction or cancelled navigation can delay notices; interruption/queue clearing can lose automatic continuation. Submitted notices can survive navigation/reload, so validate current handle ownership before acting. Delivery is not exactly once, and shutdown cancels work without crash recovery. See [Pi Extensions](https://github.com/paleo/alignfirst/blob/main/docs/pi-extensions.md) and the linked package READMEs for contracts.

## 5. Start the assistant

Start the host in the project's repository and invoke `/aligndev` in Claude Code, `$aligndev` in Codex, or `/skill:aligndev` in Pi. The skill runs `npx -y aligndev guide`; no global AlignDev CLI installation is required. Confirm skill discovery and the requested tools without changing trust/settings merely to test them.

## Permissions

Claude Code/Codex parents use their established elevation: request escalated permissions in Codex, or disable Claude Code's sandbox for the launch when enabled. The developer approves those requests because the child needs network and writes outside the project.

Pi and both extensions use ordinary OS permissions. The cwd controls discovery, not filesystem isolation. Saved project trust controls resource loading, not tool access; `code.skipPermissions` has no effect on Pi. The CLI prepares companions and injects project context; the generic tool only honors command and cwd.
