# A Coding Agent as the Assistant

A coding agent (Claude Code or Codex) can act as the AlignFirst assistant on one project: the repository where its session starts. It follows the `aligndev` playbook and delegates the work to the agent that `aligndev code` launches. It needs no OpenClaw deployment.

Supported systems: Linux and macOS, and Windows through WSL.

## 1. Prepare the project

The project needs a `.plans` directory, in its repository or in its companion directory. Follow [AlignFirst setup](alignfirst-skills-setup.md#configure-the-project), with [plans-setup.md](plans-setup.md) for a work-files repository, or [companion-setup.md](companion-setup.md) for a repository that must stay untouched.

The assistant reads the project's `DEVELOPERS.md` when it exists, else the `README.md` at the repository root. [Prepare a Project for an Assistant](../SKILL.md#prepare-a-project-for-an-assistant) describes its content.

## 2. Configure `aligndev` (recommended)

Without a config, `aligndev` launches the same agent as the one that runs the assistant, detected from its environment. A config makes the choice explicit, which matters when the detection is ambiguous, for example Codex started in a VS Code terminal where the Claude Code extension also sets its variable. Write `~/.alignfirst/aligndev.config.json`:

```json
{
  "code": { "agent": "claude" }
}
```

`code.agent` names the agent that `aligndev code` launches: `claude` or `codex`. It may differ from the agent that runs the assistant. The [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#configuration) documents the optional `code` keys.

Check whether the developer's shell exports `ANTHROPIC_API_KEY` (Claude Code) or `CODEX_API_KEY` (Codex); check the names only, never print the values. The agent runs non-interactively (`claude -p`, `codex exec`), where such a key overrides the subscription login, even when the developer's own session declined it. When the developer wants the agent on their subscription, list the key in `code.unset`:

```json
{
  "code": { "agent": "claude", "unset": ["ANTHROPIC_API_KEY"] }
}
```

## 3. Install the skill

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes --skill aligndev </dev/null
```

Add `--agent claude-code` or `--agent codex` to target one agent. Restart the agent after installation.

Without a skill, add the "Aligndev" section from the [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#without-a-skill) to the developer's global agent instructions instead. The user then asks the session to work with aligndev.

## 4. Start the assistant

Start the agent in the project's repository and invoke `/aligndev` in Claude Code, or `$aligndev` in Codex. The skill runs `npx -y aligndev guide`, so `aligndev` needs no installation.

## Sandbox

The launched agent needs network access and writes outside the project, which the assistant's sandbox blocks. The assistant therefore runs `aligndev code` outside its sandbox: it requests escalated permissions in Codex, or disables the sandbox for that command in Claude Code when sandboxing is on. The developer approves each request.
