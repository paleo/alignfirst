# OpenClaw Coder (experimental)

Turn an [OpenClaw](https://openclaw.ai/) agent into an autonomous AI programmer. Two use cases:

1. **For developers** — a programming partner, not a programming tool.
2. **For non-developers** — a teammate who handles simple coding tasks.

## Architecture

Install OpenClaw on a VPS.

```mermaid
flowchart TD
  U([User]) -->|"asks via Discord / Slack"| O[OpenClaw]
  O -->|"delegates the task<br/>(openclaw-coder-playbook + alignfirst-coaching skills)"| CC[Claude Code]
  CC -->|"does the work<br/>(alignfirst skill)"| FS[(Your codebase)]
```

OpenClaw runs the conversation and, when there's code to write, hands the task to Claude Code through the **`openclaw-coder-playbook`** and **`alignfirst-coaching`** skills. Claude Code does the actual work with the **`alignfirst`** skill, then returns the result for OpenClaw to relay back to the user.

### Supported OpenClaw channels

The playbook is designed for **Slack** and **Discord**.

## Configuring the VPS

### Your projects

Put your git repositories in `~/projects/`.

If your bot needs access to a git platform (GitHub, GitLab), set it up.

### Claude Code

Your AI developer is a modern developer. It needs the real Claude Code CLI.

- Install the [Claude Code CLI](https://claude.com/product/claude-code) and authenticate it with your account. The `claude` command must work in the terminal.
- Install the `alignfirst` skill:

```bash
npx skills add https://github.com/paleo/alignfirst --global --yes --agent claude-code --skill alignfirst
```

Skill:

- **`alignfirst`** — spec/plan/code workflow for coding tasks.

### Skills for OpenClaw

OpenClaw will need these skills: `openclaw-coder-playbook`, `alignfirst-coaching`, `alignfirst`:

```bash
npx skills add https://github.com/paleo/alignfirst --global --yes --agent universal \
  --skill openclaw-coder-playbook --skill alignfirst-coaching --skill alignfirst
```

Skills:

- **`openclaw-coder-playbook`** — operating instructions for an OpenClaw AI coder.
- **`alignfirst-coaching`** — teaches the agent to delegate coding tasks to Claude Code.
- **`alignfirst`** — not strictly needed, but it helps the bot understand its coding tool.

Optional `alignfirst-coaching` environment variables:

```bash
export ALIGNFIRST_COACHING_LOG_DIR=path/to/directory # Write input/output logs
export ALIGNFIRST_COACHING_SKIP_PERMISSIONS=1        # Use --dangerously-skip-permissions instead of --permission-mode auto
```

### `openclaw.json`

OpenClaw needs a coding tool profile that can still post to chat, and the three skills wired in:

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["message"] // let the channel session open threads and post
  },
  "agents": {
    "defaults": {
      "skills": ["alignfirst", "alignfirst-coaching", "openclaw-coder-playbook"]
    }
  },
  "channels": {
    "slack": {
      "replyToMode": "all",
      "thread": { "initialHistoryLimit": 100 }
    },
    "discord": {
      // Leave `autoThread` off for Discord
    }
  }
}
```

The playbook expects each task to run in its **own thread session**. With Slack, `replyToMode: "all"` answers every user message in a new thread. On Discord the agent opens the thread itself, so `autoThread` stays off; `alsoAllow: ["message"]` is what lets it do so.

### `workspace/AGENTS.md`

Here is an example of a workspace's `AGENTS.md`:

```markdown
# Operating Instructions

On every user message, before any reply text and before any other tool call, your first action is to load the `openclaw-coder-playbook` skill and follow its `SKILL.md`.

Do not improvise — no announcement, no `ls`, `grep`, `find`, or project lookup before the playbook is read and followed.

## Language

Replies to the user follow the user's language. Internal reasoning stays in English.

## Tickets are labels, not lookup targets

When a user mentions a ticket ID (`ABC-123`, `12`, …), it's a label for branch names, thread names, and the AlignFirst workflow — not an invitation to look up its content. Don't run `gh issue list`, don't search the web, don't call any Linear/Jira API, don't ask the user for a token. The user will tell you in chat what they want. Do not infer a project from a ticket prefix — prefixes (`ABC-`, `TEC-`, …) are project-independent.
```

The only required part is the first paragraph.

About tickets: feel free to replace this with your own instructions on how to access your Linear, Jira, or GitHub/GitLab issues.

## Contribute

The `openclaw-coder-playbook` skill is developed against an internal regression-test harness: [`playbook-test/README.md`](playbook-test/README.md). Maintainer overview: [`docs/openclaw-coder.md`](../docs/openclaw-coder.md).
