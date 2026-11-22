---
title: Setup Guide
summary: How the `alignfirst setup` guide is stored, rendered and maintained — templates, topic registry, placeholders, the bootstrap section and the OpenClaw skill.
read_when:
  - changing a setup topic or the setup entry guide
  - adding a setup topic
  - changing the canonical bootstrap section or its diagnosis
  - changing the skill `aligndev-openclaw-setup`
---

# Setup Guide

The setup guide tells an agent how to install, configure or upgrade AlignFirst tooling in a project. It ships inside the `alignfirst` package and is read through the CLI:

| Command | Prints |
| --- | --- |
| `alignfirst setup` | `# Project state` (the inspection report), then the entry guide |
| `alignfirst setup guide [<topic>]` | One topic, or the topic list |
| `alignfirst setup init` | Performs the protocol adoption steps |
| `alignfirst setup instructions` | The bootstrap section's status and canonical text |

`alignfirst context` ends with a `# Setup` section (`templates/context/setup.md`) that points agents at `alignfirst setup`.

## Templates

Everything lives under `packages/alignfirst/templates/setup/`:

- `entry.md` — routes by intent, the topic list and the cross-cutting rules;
- `topics/<name>.md` — one file per topic;
- `snippets/bootstrap.md` and `snippets/global-bootstrap.md` — the canonical instruction sections;
- `examples/alignfirst.json` — the sample workspace manifest.

The source is in `packages/alignfirst/src/setup/`: `topics.ts` (registry and renderer), `report.ts` (state report), `init.ts`, `instructions.ts` (pure diagnosis and insertion) and `instruction-status.ts` (file access, shared with `doctor`). `src/commands/setup.ts` routes the sub-commands.

## Topic Registry

`SETUP_TOPICS` in `src/setup/topics.ts` declares each topic's `name`, `title` (the template's `#` heading) and one-line `description`. The entry guide's topic list, the `setup guide` list and the unknown-topic error render from it.

To add a topic:

1. Create `templates/setup/topics/<name>.md`, starting with its `#` heading.
2. Add its entry to `SETUP_TOPICS`.
3. Add a route line to `entry.md` when users reach it by intent.

`test/setup.test.ts` renders every registered topic and fails when a placeholder survives, or when a template names `setup guide <name>` for an unregistered topic.

## Placeholders

`renderSetupTemplate` renders them in this order:

| Placeholder | Rendered as |
| --- | --- |
| `{{CMD}}` | The caller's invocation form, such as `npx -y alignfirst` or `bunx --bun alignfirst` |
| `{{TOPICS}}` | The topic list from the registry |
| `{{SKILLS}}` | The `skills` CLI through the caller's package runner, such as `npx -y skills` or `pnpm dlx skills` |
| `{{SKILLS_INSTALL}}` | The `skills add` command for every command skill plus `aligndev`, with `--agent <host>`; templates add the code fence |
| `{{SAMPLE_MANIFEST}}` | The content of `examples/alignfirst.json` |
| `{{PROJECT_PATH}}` | The main-worktree path, in `snippets/global-bootstrap.md` only |

## Writing Rules

- **One home per concept.** A fact lives in one topic. Other topics point to it.
- **Pointers are commands.** Write `` `{{CMD}} setup guide <topic>` ``, and quote a section title when the pointer targets a section. Error messages in the packages cite topics the same way, such as "Convert the Companion Registry" in `alignfirst setup guide upgrade`. A message renders the caller's form when its package knows it, as AlignDev does; otherwise it writes `alignfirst`. Keep those titles stable.
- **Launchers are placeholders.** Write `{{CMD}}` for `alignfirst` and `{{SKILLS}}` for the `skills` CLI. A literal launcher states a fixed fact, such as the `aligndev` skill running `npx -y aligndev guide`.
- **Mechanical steps are commands.** When a command performs a step (`setup init`, `setup instructions --write`, `companion register --item`), the topic gives the command instead of the manual procedure.
- **Never restate another guide.** A fact already stated by a package README, `workspace --guide`, `docmap --guide` or `aligndev guide` is pointed to.

## The Bootstrap Section

`snippets/bootstrap.md` is the canonical `## Start every session with the project context` section. `setup instructions` diagnoses the project's `AGENTS.md` and `CLAUDE.md` against it, with the status `absent`, `current`, `differs`, `ambiguous` or `global`. The comparison covers the heading and the paragraph holding `alignfirst context`, with whitespace normalized and the launcher ignored. `global` applies when the companion registration's `defaultLocation` is `companion`; the command then prints `snippets/global-bootstrap.md` instead.

The same diagnosis feeds the `Instructions` item of the `setup` report, the `Instructions` step of `setup init`, and the `Instructions` section of `doctor`: `ok` for `current` and `global`, `info` for `absent`, `warn` for `differs` and `ambiguous`.

Changing the snippet's wording turns every existing section into `differs`. This repository's `AGENTS.md` carries the canonical section: `node packages/alignfirst/bin/alignfirst.mjs setup instructions` must report it as current.

## The OpenClaw Skill

The OpenClaw material is a separate skill, `skills/aligndev-openclaw-setup/`, distributed through `npx skills add`. It holds the admin-repository template under `assets/aligndev-openclaw-template/`. It keeps its own freshness gate, which compares the installed `metadata.version` with the upstream one: bump that version whenever the skill or its assets change. Its pointers to the setup guide are `npx -y alignfirst setup guide <topic>` commands.
