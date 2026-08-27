---
title: Architecture Overview
read_when:
  - onboarding to the administration repository
  - tracing a request from chat to a managed project
---

# Architecture Overview

{{DEVELOPER_NAME}} receives requests on the selected Slack or Discord surface. OpenClaw binds each
surface to a session and loads a lean workspace. The `alignfirst-developer-openclaw-playbook` skill
routes channel requests into threads and governs working sessions.

```text
Slack or Discord
  → OpenClaw gateway and workspace
  → AlignFirst Developer playbook
  → alproject project selection
  → alcode delegation
  → selected Claude Code or Codex CLI
  → managed project workspace
```

The OpenClaw runtime model is independent from the delegated coding agent. `alcode` selects the
delegated CLI through `ALIGNFIRST_CODE_AGENT`; OpenClaw authenticates its own provider separately.

## Ownership Boundaries

- Version-controlled files in this repository describe the intended deployment.
- `infra/openclaw/generated/` contains derived runtime configuration and stays untracked.
- Secrets live in restricted service-user storage and are referenced by name.
- The privileged administrator owns host packages, service-account creation, firewall policy, and
  lingering setup.
- The service user owns OpenClaw, coding-agent authentication, managed-project clones, and user
  services.
- Managed repositories own their builds, tests, workspace wrappers, and `DEVELOPERS.md` instructions.

## Context Boundaries

Only top-level OpenClaw workspace bootstrap files load automatically. `AGENTS.md` points directly to
the playbook dispatcher. The dispatcher loads the surface procedure; `alcode --openclaw-guide` loads
only when delegation begins. Keep situational procedures outside bootstrap files.

## Next Document

For a new deployment, start with [server setup](installations/01-server-setup.md). For an existing
deployment, use docmap to find the relevant operations, recovery, or troubleshooting runbook.
