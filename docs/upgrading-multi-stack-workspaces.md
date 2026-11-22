---
title: Upgrading Multi-Stack Workspaces
summary: Agent runbook for the clean break from JavaScript wrappers and legacy configuration to the AlignFirst workspace CLI.
read_when:
  - upgrading a consumer with .alignfirst.json or workspace wrappers
  - converting old workspace registries or port slots
  - coordinating worktree cleanup before the multi-stack cutover
---

# Upgrading Multi-Stack Workspaces

Run `npx -y alignfirst setup guide upgrade-workspaces` and follow the runbook it prints. It covers resource accounting, old-tool cleanup, configuration conversion and coordinated cutover.
