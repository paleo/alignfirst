# AlignFirst Setup

Install the AlignFirst CLI and its eight stub skills, then configure the consumer repository.
AlignFirst does not require the standalone docmap package or workspace.

## Install the CLI

Install the CLI globally on the developer's machine:

```sh
npm install -g alignfirst
```

Add `npm install -g alignfirst` to the README prerequisites so teammates install the same command.

## Install the Skills

The `alignfirst` skill loads the requested protocol or helps choose one. `alspec`, `alplan`, `al`, `almerge`, `alreview`, `aldescription`, and `alcatchup` select individual protocols. Skills reuse guides already in context; each named guide includes shared conventions. Humans invoke them with `/` in Claude Code, GitHub Copilot, and Cursor, or `$` in Codex.

Discover the package without installing it:

```sh
npx -y skills add https://github.com/paleo/alignfirst --list </dev/null
```

For Claude Code:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

For Codex:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

For both agents:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

Restart the target agent after installation. Use `npx -y skills update --global --yes` to update
global skills, or `npx -y skills update --project --yes` for project skills. Remove an installation
with `npx -y skills remove [--global] <skill-name> --yes`. Let the skills CLI manage
`skills-lock.json`.

## Configure the Project

Choose with the user between the following equal configurations. Both create `.plans/` and add it to
`.gitignore`:

```sh
mkdir .plans
printf '%s\n' .plans >> .gitignore
```

### Without `.alignfirst.json`

Detect the commit-message convention, default branch, and ticket format. Preserve project-specific
instructions and add or update this section in `AGENTS.md` or `CLAUDE.md`:

```markdown
## AlignFirst

_Commit message convention:_ `{DETECTED_CONVENTION}`

_Default branch:_ `{DETECTED_DEFAULT_BRANCH}`

_Ticket ID format:_ `{DETECTED_TICKET_FORMAT}`
```

Omit any convention that repository evidence cannot establish. When the project uses a team plans
repository, add: After every change in `.plans/`, run `alignfirst sync`.

### With `.alignfirst.json`

Detect the ticket format from branches and tickets: `^\d+$` for issue numbers,
`^[A-Z]+-\d+$` for Jira-like keys, or no field without a convention. Detect the commit style with
`git log --oneline -20`. Resolve the default branch with
`git ls-remote --symref origin HEAD`; use the sole remote when `origin` is absent, and ask the user
when several non-`origin` remotes exist.

Write `.alignfirst.json` with the agreed fields. Never add `cli`:

```json
{
  "schemaVersion": 1,
  "ticketIdPattern": "^\\d+$",
  "plans": { "folder": "acme-web", "autoArchive": true },
  "portRange": { "first": 8100, "last": 8299 },
  "git": {
    "defaultBranch": "main",
    "branchNameTemplate": "{ticketId}/{slug-1-3-words}",
    "commit": { "style": "conventionalCommit", "ticketReference": "bracketedHash" },
    "agentCoauthoring": false
  }
}
```

Keep only applicable optional fields. Replace any hand-written AlignFirst or docmap section in
`AGENTS.md` or `CLAUDE.md` with one bootstrap line. Use `alignfirst context` when the project uses
docmap and `alignfirst conventions` otherwise:

```markdown
## AlignFirst

Before inspecting or changing this repository, run `alignfirst context` once from the repository root and follow its output.
```

### Local installation

Use this only when the user requests a project-local CLI. Add the exact current `alignfirst` version
as a dev dependency with the project package manager and install dependencies before invoking it.
Write `npx alignfirst context` or `npx alignfirst conventions` in the instruction file and local skill
stubs. A global installation is the default. No npm script is required.

Continue with [plans-setup.md](plans-setup.md) when the team has a plans repository. Finish with:

```sh
alignfirst config
alignfirst doctor
```
