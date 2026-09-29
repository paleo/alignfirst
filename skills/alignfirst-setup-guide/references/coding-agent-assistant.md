# A Coding Agent as the Assistant

A coding agent (Claude Code or Codex) can act as the AlignFirst assistant on one project: the repository where its session starts. It follows the `aldev` playbook and delegates the work to coder sessions through `aldev code`. It needs no OpenClaw deployment.

Supported systems: Linux and macOS, and Windows through WSL.

## 1. Prepare the project

The project needs a `.plans` directory, in its repository or in its companion directory. Follow [AlignFirst setup](alignfirst-skills-setup.md#configure-the-project), with [plans-setup.md](plans-setup.md) for a work-files repository, or [companion-setup.md](companion-setup.md) for a repository that must stay untouched.

The assistant reads the project's `DEVELOPERS.md` when it exists. [Prepare a Project for an Assistant](../SKILL.md#prepare-a-project-for-an-assistant) describes its content.

## 2. Configure `aldev`

Write `~/.config/alignfirst/aldev.config.json`:

```json
{
  "platform": "codingAgent",
  "code": { "agent": "claude" }
}
```

`code.agent` names the coder: `claude` or `codex`. It may differ from the agent that runs the assistant. The [`aldev` README](https://github.com/paleo/alignfirst/tree/main/packages/aldev#configuration) documents the optional `code` keys.

## 3. Install the skill

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes --skill aldev </dev/null
```

Add `--agent claude-code` or `--agent codex` to target one agent. Restart the agent after installation.

## 4. Start the assistant

Start the agent in the project's repository and invoke `/aldev` in Claude Code, or `$aldev` in Codex. The skill runs `npx -y aldev guide`, so `aldev` needs no installation.

## Sandbox

The coder needs network access and writes outside the project, which the agent's sandbox blocks. The assistant therefore runs `aldev code` outside its sandbox: it requests escalated permissions in Codex, or disables the sandbox for that command in Claude Code when sandboxing is on. The developer approves each request.
