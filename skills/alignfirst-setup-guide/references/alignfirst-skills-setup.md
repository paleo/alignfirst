# AlignFirst Setup

Install the requested AlignFirst components. The protocols work through the CLI without skills; the skills invoke the CLI through `npx` without a separate CLI installation. Neither requires standalone Docmap or workspace.

For a skills-only request, follow **Install the Skills**. Configure the project only when the user also wants the repository to adopt AlignFirst. For a protocols-only request, configure the project and omit skill installation.

## Install the CLI

Project files invoke the CLI as `npx alignfirst`, which requires no installation. `npx` resolves a project dependency or fetches the CLI from the registry and caches it. The project therefore works on a machine that has never installed AlignFirst.

Installing the CLI globally provides the bare `alignfirst` command:

```sh
npm install -g alignfirst
```

Offer this in the README as a convenience and use the bare command when describing it. Project instructions remain on `npx alignfirst` and never depend on the global installation.

## Install the Skills

`alspec`, `alplan`, `al`, `almerge`, `alreview`, and `aldescription` select individual protocols. `alcatchup` loads ticket history; `alcatchupaad` and `alcatchupspec` load history before starting AAD or specification. Skills reuse guides already in context; each named guide includes the ticket directory and work file rules. Humans invoke them with `/` in Claude Code, GitHub Copilot, and Cursor, `$` in Codex, or `/skill:name` in Pi (for example `/skill:alspec` or `/skill:alplan`).

The optional `alignfirst` skill lets the agent recognize a protocol named in prose. Add `--skill alignfirst` when the user wants that recognition in repositories without an `alignfirst context` instruction.

The AlignFirst skills are installed globally only. When a global installation fails for lack of write access, report it once and continue without the skills. Never fall back to another location. On an AlignDev OpenClaw host, the service account's skill directories are admin-owned and locked, by design.

When preparing a project for an assistant, skip the skills and the [global bootstrap line](#repositories-without-alignfirst-instructions), as [Prepare a Project for an Assistant](../SKILL.md#prepare-a-project-for-an-assistant) states.

Discover the package without installing it:

```sh
npx -y skills add https://github.com/paleo/alignfirst --list </dev/null
```

For Claude Code:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup \
  --skill alcatchupaad --skill alcatchupspec </dev/null
```

For Codex:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup \
  --skill alcatchupaad --skill alcatchupspec </dev/null
```

For Pi (verified with `skills@1.7.2`, target `pi`):

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent pi \
  --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup \
  --skill alcatchupaad --skill alcatchupspec </dev/null
```

Pi discovers global `~/.agents/skills/`; the verified installer writes there. Confirm current help/source when upgrading, since target layouts can change. Invoke `/skill:alspec`, not `/alspec`, in stock Pi.

For Claude Code and Codex together:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code --agent codex \
  --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup \
  --skill alcatchupaad --skill alcatchupspec </dev/null
```

Restart the target agent after installation. Update the skills with `npx -y skills update --global --yes`, and remove one with `npx -y skills remove --global <skill-name> --yes`.

### Optional Pi subagents

For a direct AlignFirst user who requests isolated plan/review delegation, offer `pi install npm:@alignfirst/pi-subagent` as a separate executable capability. The protocols retain their host-neutral fallback when no subagent tool exists. A skills-only request installs no extensions; the generic background package is unnecessary for synchronous delegation.

Before replacing an existing local `subagent` extension, obtain approval and disable it explicitly with `pi config`; keep its profiles and do not load both tools. `/reload` cancels active subagents and background jobs. The package targets Pi 1.3.0 and requires Node.js 22.19 or later. It preserves normal Pi project-trust discovery without forced approval. See [the package README](https://github.com/paleo/alignfirst/blob/main/packages/pi-subagent/README.md).

## Configure the Project

Add the **Project Instructions** section below, then choose with the user between the following equal configurations. Both create `.plans/` and add it to
`.gitignore`:

```sh
mkdir .plans
printf '%s\n' .plans >> .gitignore
```

Detect the conventions first. Take the ticket format from branches and tickets: `^\d+$` for issue numbers, `^[A-Z]+-\d+$` for Jira-like keys, or none without a convention. The pattern is one anchored expression; alternatives go inside a group, as in `^(ABC|XYZ)-\d+$`. Take the branch-name template from existing branches, and the commit style from `git log --oneline -20`. Resolve the default branch with `git ls-remote --symref origin HEAD`; use the sole remote when `origin` is absent, and ask the user when several non-`origin` remotes exist. Omit any convention that repository evidence cannot establish.

### Without `.alignfirst.json`

Add a `### Conventions` sub-section at the end of the bootstrap section from **Project Instructions**, in the format `alignfirst context` prints:

```markdown
### Conventions

- Ticket IDs: `{DETECTED_TICKET_PATTERN}`.
- Branch names: `{DETECTED_BRANCH_TEMPLATE}`.
- Commits: `{DETECTED_COMMIT_FORMAT}`.
```

Add `- Default branch: {DEFAULT_BRANCH}.` only when `git symbolic-ref refs/remotes/<remote>/HEAD` fails; otherwise the CLI reads it from git. When an existing section states these conventions, move them here.

### With `.alignfirst.json`

Write `.alignfirst.json` with the detected fields:

```json
{
  "schemaVersion": 1,
  "ticketIdPattern": "^\\d+$",
  "plans": { "repositoryFolder": "acme-web", "autoArchive": true },
  "portRange": { "first": 8100, "last": 8299 },
  "git": {
    "defaultBranch": "main",
    "branchNameTemplate": "{TICKET_ID}/{slug-1-3-words}",
    "commit": { "style": "conventionalCommit", "ticketReference": "bracketedHash" },
    "agentCoauthoring": false
  }
}
```

Keep `plans.autoArchive: true`, including in local mode; the user can remove it to opt out. Keep only the other applicable optional fields. Omit `cli` unless the user asks to pin the CLI version. It takes a range of full `x.y.z` versions, each with an optional `^`, `~`, `>=`, `>`, `<=`, `<` or `=`. Spaces join versions that must all hold; `||` joins alternatives. The version guard then rejects a mismatching CLI and prints the matching `npx -y alignfirst@"<range>"` command.

### Local installation

By default a project declares no `alignfirst` dependency. Add one only when the user asks for a pinned CLI, or when the repository gates installation on publication age or provenance and so cannot accept an on-demand fetch.

Add the exact current `alignfirst` version as a dev dependency with the project package manager, and install dependencies before invoking it. The instruction file keeps `npx -y alignfirst context`, which then resolves the pinned binary. No npm script is required.

The CLI's only dependency is `@alignfirst/docmap`. A repository with such gates must allow it too, since the CLI tracks its releases closely.

Continue with [plans-setup.md](plans-setup.md) when the team has a work-files repository. Finish with:

```sh
npx alignfirst config
npx alignfirst doctor
```

## Project Instructions

When the repository adopts AlignFirst skills or protocols, read the existing `AGENTS.md` or `CLAUDE.md` before editing it. Insert this as its first `##` section, after any frontmatter, `#` title, or introductory prose. When other `##` sections exist, place it immediately before the first. It works with or without `.alignfirst.json`:

```markdown
## Start every session with the project context

Run `npx -y alignfirst context` from the repository root as your first command, whatever the task. It prints the project conventions (ticket IDs, branch names, commits), the documentation map, and the AlignFirst protocols.
```

Replace any `Docmap - Seek Documentation` section and redundant protocol instructions. Preserve essential-documentation lists and project conventions that are not represented in `.alignfirst.json`.

### Repositories Without AlignFirst Instructions

A developer who works in a repository without this section, such as a companion-backed one ([companion-setup.md](companion-setup.md)), adds this section to their global agent instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, or the agent's equivalent), with the project's path:

```markdown
## AlignFirst - Start every session with the project context

When you work on the project `/path/to/a/project`, run `npx -y alignfirst context` as your first command, whatever the task.
```

Add one line per such project to the same section. The section uses no agent-specific mechanism.
