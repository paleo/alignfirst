# AlignFirst monorepo

Companion products for AI-assisted software work. They can be used independently.

## `alignfirst` CLI

The `alignfirst` CLI provides the AlignFirst workflows. See [the CLI README](packages/alignfirst/README.md) for installation and usage.

### Agent skills

Eight Agent Skill stubs expose the CLI through commands such as `/alspec` in Claude Code and `$alspec` in Codex. See [the Agent skills section](packages/alignfirst/README.md#agent-skills).

## Docmap - Agent-discoverable documentation

`@paleo/docmap` is a lightweight table of contents that lets agents navigate documentation files. This way we have one set of docs, shared by humans and AI agents. See [packages/docmap/README.md](packages/docmap/README.md).

## Workspaces - Local environments with worktrees

`@paleo/workspace` runs multiple dev environments side by side using git worktrees. See [packages/workspace/README.md](packages/workspace/README.md).

## OpenClaw Test toolkit

`@paleo/openclaw-test` and three companion channel packages: they are a Dockerised regression-test harness that drives OpenClaw through synthetic Discord and Slack channels. See [packages/openclaw-test/README.md](packages/openclaw-test/README.md).

## AlignFirst Developer

AlignFirst Developer is an AI teammate for software work, currently packaged on OpenClaw. See [alignfirst-developer.md](alignfirst-developer.md).

---

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

---

## Contribute

After a fresh clone:

```sh
npm install
npm run build --workspace @paleo/workspace
npm run workspace -- setup
```

The everyday workflow is in [`DEVELOPERS.md`](DEVELOPERS.md).
