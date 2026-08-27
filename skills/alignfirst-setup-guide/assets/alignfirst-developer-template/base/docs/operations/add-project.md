---
title: Add a Managed Project
read_when:
  - onboarding a repository for AlignFirst Developer work
---

# Add a Managed Project

## Prepare the Repository

**Role: managed project.** Clone a canonical main worktree directly beneath an allowed project parent.
Use the retained global `alignfirst-setup-guide` through the selected coding agent to prepare the full
contract:

1. AlignFirst content and command skills plus project instructions.
2. plans-share when a team plans repository exists.
3. docmap scripts and instructions.
4. an adapted workspace wrapper and verified lifecycle.
5. a project-specific `DEVELOPERS.md`.

Inspect the real package manager, runtime, build, test, lint, dev-server, ports, shared directories,
seeded files, and team plans. Do not copy admin-repository assumptions into the project.

## Register

**Role: service user.** Run the project's main workspace setup and validation first. Then:

```sh
alproject status '<canonical-main-worktree>' --json
alproject register '<canonical-main-worktree>'
alproject list --json
```

Add port allocation flags only when the project's workspace config uses the matching range.

## Verify

From the allowed channel, select the project, establish its thread, create a read-only workspace task,
and confirm the result returns to that thread. Remove the test workspace through the project's wrapper.
