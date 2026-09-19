# AlignFirst monorepo

Companion products for AI-assisted software work. They can be used independently.

## `alignfirst` CLI

The `alignfirst` CLI provides the AlignFirst workflows. See [the CLI README](packages/alignfirst/README.md) for installation and usage.

### Agent skills

Nine Agent Skill stubs expose the CLI through commands such as `/alspec` in Claude Code and `$alspec` in Codex. See [the Agent skills section](packages/alignfirst/README.md#agent-skills).

## Docmap - Agent-discoverable documentation

`@alignfirst/docmap` is a lightweight table of contents that lets agents navigate documentation files. This way we have one set of docs, shared by humans and AI agents. See [packages/docmap/README.md](packages/docmap/README.md).

## Workspaces - Local environments with worktrees

`@alignfirst/workspace` runs multiple dev environments side by side using git worktrees. See [packages/workspace/README.md](packages/workspace/README.md).

## OpenClaw Test toolkit

`@alignfirst/openclaw-test` and three companion channel packages are a Dockerised regression-test harness that drives OpenClaw through synthetic Discord and Slack channels. See [packages/openclaw-test/README.md](packages/openclaw-test/README.md).

## AlignFirst Dev Kit for OpenClaw

The Dev Kit deploys an AI teammate for software work. One deployment is a **claw**. See [alignfirst-dev-kit.md](alignfirst-dev-kit.md).

[`@alignfirst/service-openclaw-plugin`](packages/service-openclaw-plugin/README.md) supplies a claw's OpenClaw capabilities under plugin ID `alignfirst-service`. Its first capability, thread handoff, durably activates the ordinary thread session after confirmed native starter delivery.

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
npm run build --workspace @alignfirst/workspace
npm run workspace -- setup
```

The everyday workflow is in [`DEVELOPERS.md`](DEVELOPERS.md).
