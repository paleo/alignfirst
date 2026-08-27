---
title: Update the Developer
read_when:
  - updating OpenClaw, global tools, skills, or admin repository dependencies
---

# Update the Developer

**Role: repository support work** prepares the change. **Role: service user** performs the reviewed
deployment. Human authentication is required if any CLI session expired.

1. Read release notes for the exact component and record rollback constraints.
2. Create a deployment backup and record current versions.
3. Unprotect only the target path or package.
4. Update one component: OpenClaw, `alcode`, `alproject`, npm dependencies, runtime playbook, delegated
   AlignFirst skills, retained setup guide, or `sysadmin`.
5. Run the component's help/guide and repository validation.
6. Re-run `seed.sh`, configuration validation, and SecretRef audit.
7. Restart only when validation passes. Restore protection.
8. Run the channel, project-selection, workspace, delegation, restart, and recovery smoke checks
   affected by the update.

Use `npx -y skills update --global --yes` or `--project --yes` for CLI-owned skills. Never edit
`skills-lock.json` manually. Keep the previous package version and backup path available for rollback.
