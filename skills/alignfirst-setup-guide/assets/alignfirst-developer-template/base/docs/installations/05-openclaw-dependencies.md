---
title: OpenClaw Dependencies
read_when:
  - installing delegation tools and skills for the service user
---

# OpenClaw Dependencies

**Role: service user.** These installations have distinct consumers. Keep their scopes and targets
separate.

## Delegation and Project Tools

```sh
npm install --global @paleo/alcode@0.10.2 @paleo/alproject@1.1.0
```

`alproject` discovers canonical managed projects. `alcode` invokes the selected delegated-agent CLI.
`ALIGNFIRST_CODE_AGENT` is set by the selected coding-agent overlay; permission bypass remains
disabled. The selected-agent runbook verifies both guides after the selector and agent CLI exist.

## OpenClaw Playbook

Install only the runtime playbook into OpenClaw's skill target:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent openclaw --skill alignfirst-developer-openclaw-playbook </dev/null
```

The playbook is OpenClaw's dispatcher. It is not part of the AlignFirst skills bundle.

## Delegated Coding-Agent Skills

Follow [the selected coding-agent runbook](08-coding-agent.md). It installs:

- `alignfirst` plus the seven human command skills for the selected delegated agent;
- a retained global `alignfirst-setup-guide` for that same agent under the service user;
- the project-local `sysadmin` skill from `https://github.com/paleo/skills` in this admin repository.

Do not expose `alignfirst-setup-guide` to OpenClaw's runtime allowlist. It is retained so `alcode` can
prepare and repair managed projects.

## Verification

Start a new selected-agent session after installation. Verify its command syntax, `alcode --guide`
selection, and `alproject --guide` through `08-coding-agent.md`. Continue with
[security hardening](06-security-hardening.md).
