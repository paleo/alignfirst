---
title: Configure the Developer
read_when:
  - changing deployment values or selected runtime components
---

# Configure the Developer

**Role: repository support work**, then **service user** for deployment.

1. Collect the changed non-secret values and identify the single owning source.
2. For a surface or delegated-agent change, render and review the replacement overlay as a complete
   module. Remove remnants of the previous selection.
3. Enter new credentials interactively in the untracked secure environment or provider login.
4. Back up the deployment.
5. Apply source through `seed.sh` and `apply-workspace.sh`.
6. Validate configuration and SecretRefs before restarting the user service.
7. Run positive and negative channel checks plus a read-only delegated command.

Changing the OpenClaw runtime provider does not change `ALIGNFIRST_CODE_AGENT`. Changing Claude Code
or Codex does not change the runtime provider.
