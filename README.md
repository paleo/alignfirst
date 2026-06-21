# AlignFirst monorepo

Companion products for AI-assisted software work. They can be used independently.

## AlignFirst skills

Collaborative spec/plan/AAD/review protocols. See [alignfirst-skills.md](alignfirst-skills.md).

## Docmap - Agent-discoverable documentation

`@paleo/docmap` — a lightweight table of contents that lets agents navigate documentation files. This way we have one set of docs, shared by humans and AI agents. Run `docmap --guide` for authoring conventions; the `alignfirst-setup-guide` skill installs it in a new repo. See [packages/docmap/README.md](packages/docmap/README.md).

## Workspaces - Local environments with worktrees

`@paleo/workspace` — run multiple dev environments side by side using git worktrees. See [packages/workspace/README.md](packages/workspace/README.md).

## OpenClaw Test toolkit

`@paleo/openclaw-test` and three companion channel packages — a Dockerised regression-test harness that drives OpenClaw through synthetic Discord and Slack channels. See [packages/openclaw-test/README.md](packages/openclaw-test/README.md).

## Autonomous AI programmer (experimental)

We're building an autonomous AI developer with _OpenClaw_. See [openclaw-coder/README.md](openclaw-coder/README.md).
