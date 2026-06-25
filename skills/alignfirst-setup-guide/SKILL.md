---
name: alignfirst-setup-guide
description: >-
  Setup-time companion to install or upgrade any subset of {docmap, workspace, alignfirst skills} in a consumer repo. Use when asked to install, set up, or upgrade docmap, the workspace worktree system, or the AlignFirst skills.
compatibility: Requires git and a Node.js package manager (npm, pnpm, yarn, or bun).
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.17.0"
  repository: https://github.com/paleo/alignfirst
---

# AlignFirst Setup Guide

A one-time companion for setting up a consumer repository. It installs any subset of three independent tools:

- **docmap** — agent-discoverable documentation under `docs/`.
- **workspace** — worktree-based concurrent local dev environments.
- **alignfirst skills** — collaborative spec/plan/AAD/review protocols.

Pick any combination. Each has its own reference; this skill investigates the repo, agrees on scope, then follows the matching reference(s).

Follow these four steps in order. Do not skip ahead: complete each before starting the next.

## Step 1 — Investigate

Detect the stack and **package manager**: check the `packageManager` field in `package.json`, else the root lockfile — `package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun — falling back to npm. Record the result — every reference in Step 3 reuses this one detection rather than repeating it.

**Commands in this guide are written for npm; convert each one to the detected manager** — both when you run it and when you write it into project files. Only npm needs a `--` separator to pass flags to a script (`npm run docmap -- --guide`); pnpm and yarn drop the `run` and the separator (`pnpm docmap --guide`), and bun keeps `run` but needs no separator (`bun run docmap --guide`). Install verbs differ too (`npm install -D` vs `pnpm add -D` / `yarn add -D` / `bun add -D`).

Then detect each tool's existing footprint:

- **docmap**: a `docmap` script, a `@paleo/docmap` dependency, or a `docs/` directory.
- **workspace**: a `workspace` script or a `@paleo/workspace` dependency.
- **alignfirst skills**: an installed alignfirst skill, a `.plans/` directory, or an `## AlignFirst` section in `AGENTS.md` / `CLAUDE.md`.

## Step 2 — Discuss

Present the findings and agree with the user on which tools to install or upgrade. Any combination is valid.

## Step 3 — Set up

Require a clean working tree first (`git status`). If it isn't clean, stop and ask the user to commit or stash. Then follow the matching reference(s):

- [docmap-setup.md](references/docmap-setup.md) — install the docmap CLI, then optionally bootstrap or migrate docs.
- [workspace-setup.md](references/workspace-setup.md) — implement the worktree system (adapt the [asset scripts](assets/), install `@paleo/workspace`).
- [alignfirst-skills-setup.md](references/alignfirst-skills-setup.md) — install the AlignFirst skills and configure the project.

**Upgrading from an older AlignFirst** (v1/v2): route through [alignfirst-upgrade.md](references/alignfirst-upgrade.md), which detects the version and follows [alignfirst-upgrade-from-v1.md](references/alignfirst-upgrade-from-v1.md) or [alignfirst-upgrade-from-v2.md](references/alignfirst-upgrade-from-v2.md).

## Step 4 — After setup

This skill is temporary. Once setup is done, the user can uninstall it. Provide them the command:

```sh
npx skills remove alignfirst-setup-guide --yes

# prune the entry in skills-lock.json
node --input-type=module -e 'import {readFileSync as r,writeFileSync as w} from "node:fs";const f="skills-lock.json",j=JSON.parse(r(f));delete j.skills["alignfirst-setup-guide"];w(f,JSON.stringify(j,null,2)+"\n")'
```
