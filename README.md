# AlignFirst monorepo

Companion products for AI-assisted software work. They can be used independently.

## AlignFirst skills

Collaborative spec/plan/AAD/review protocols. See [alignfirst-skills.md](alignfirst-skills.md).

### Team plans repository

`@paleo/plans-repo` shares the `.plans` directory of the AlignFirst skills among a team, through a dedicated plans repository. See [packages/plans-repo/README.md](packages/plans-repo/README.md).

## Docmap - Agent-discoverable documentation

`@paleo/docmap` is a lightweight table of contents that lets agents navigate documentation files. This way we have one set of docs, shared by humans and AI agents. See [packages/docmap/README.md](packages/docmap/README.md).

## Workspaces - Local environments with worktrees

`@paleo/workspace` runs multiple dev environments side by side using git worktrees. See [packages/workspace/README.md](packages/workspace/README.md).

## OpenClaw Test toolkit

`@paleo/openclaw-test` and three companion channel packages: they are a Dockerised regression-test harness that drives OpenClaw through synthetic Discord and Slack channels. See [packages/openclaw-test/README.md](packages/openclaw-test/README.md).

## Autonomous AI programmer

When _OpenClaw_ uses AlignFirst, we obtain a teammate, an AI partner more than an AI agent. See [openclaw-coder/README.md](openclaw-coder/README.md).

## Setup with your agent

Our `alignfirst-setup-guide` skill can help to install these tools. Temporarily install the skill (globally or locally):

```bash
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then, in your project, ask your agent:

```text
Use your alignfirst-setup-guide skill. What can I set up in this project?
```

At the end, feel free to uninstall the skill. It won't be used by your project anymore.

