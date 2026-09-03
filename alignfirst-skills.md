# AlignFirst Skills

AlignFirst enables AI agents to write the code you would write. It's distributed as an _Agent Skill_ and works well with:

- **GitHub Copilot**
- **Cursor**
- **Claude Code**
- **OpenAI Codex**

## Installation

```bash
npm install -g alignfirst
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription --skill alreview --skill alcatchup --skill almerge
```

The skills are stubs that run `npx -y alignfirst guide`. Protocol updates come with the CLI; run
`npm update -g alignfirst` to receive them.

> **Note:** We recommend installing these skills globally.
>
> After installation, you need to restart your agent (start a new session) for the skills to become available.

### Configure your project (optional)

This adds `.plans` to `.gitignore` and an AlignFirst section to your `AGENTS.md` (or `CLAUDE.md`). Install the setup-guide skill temporarily:

```bash
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then ask your agent:

```md
Use your *alignfirst-setup-guide* skill. Configure the `alignfirst` skills in this project.
```

Once done, you can uninstall the setup-guide skill, it won't be used by your project anymore.

> **Note (2026-03-09):** On Cursor, to make the skills available as commands (using `/`), I had to create a symlink: `cd ~/.cursor/ && ln -s ../.agents/skills .`

## Usage

_Note: Our commands need a ticket ID. If it can't be deduced, the agent will ask you for it. This is actually a directory name in `.plans/`, feel free to invent one if needed, like `AB-123`._

### Specification

A technical specification can be written long before the implementation. The agent helps you write it by investigating and initiating a discussion:

```markdown
/alspec [something to do]
```

The agent will discuss it with you, then write a `.plans/AB-123/A1-spec.md` file.

_Note: `A1` means it's the first file of cycle A (files are organized into cycles, it's just a way to keep files chronologically ordered)._

### Plan(s)

Implementation plans orchestrate what agents or subagents will do:

```markdown
/alplan
```

The agent reads the spec and writes a plan `.plans/AB-123/A2-plan.md`, or a main plan `.plans/AB-123/A2-main-plan.md` with several sub-plans.

### Implementation

**Clear the context**, then execute the plan(s):

```markdown
Execute the plan `.plans/AB-123/A2-main-plan.md`
```

The agent executes the plan and writes `.summary.md` files.

### Align-and-Do Protocol (AAD)

A lightweight protocol for small tasks that don't need specs or plans:

```markdown
/al [something to do]
```

The agent will discuss it with you first, then work directly on the codebase. At the end, a `.plans/AB-123/A1-AAD.summary.md` file will be written.

### PR/MR Description

Generate a summary of the work done, using all specs and summaries in the task directory:

```markdown
/aldescription
```

The agent writes a `.plans/AB-123/B1-description.md` file with a short description of what was done and a Conventional Commits message.

### Code Review

Generate a code review report for the current branch:

```markdown
/alreview
```

To compare against a specific branch instead of the default:

```markdown
/alreview compare to the `feat/456` branch
```

The agent writes a `.plans/AB-123/B1-review.md` file.

### Merge

Resolve conflicts after a merge or rebase:

```markdown
/almerge
```

The agent investigates both sides of each conflict, resolves them, and writes a `.plans/AB-123/A4-merge.summary.md` file documenting any tricky resolutions.

### Catch Up

Load the history of the current ticket, then continue with your instructions or get a synthesis:

```markdown
/alcatchup
/alcatchup then start an AAD: …
```

## Rationale

Specs, plans, and summaries should be written in well-organized (git-ignored) local files, because:

1. The context window is limited, the compression mechanism is opaque, and we want to be able to continue an unfinished task in a fresh session.
2. It's a way to keep track of what was agreed upon with the agent and what has been done.

## Upgrade from v1, v2 or v3

1. Install the setup-guide skill:

   ```bash
   npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
   ```

2. Ask your agent to follow the setup guide's upgrade route:

   ```text
   Use your alignfirst-setup-guide skill. Upgrade AlignFirst in this project.
   ```

## License

CC0 1.0 Universal.
