# AlignFirst Skills

AlignFirst enables AI agents to write the code you would write. It's distributed as an _Agent Skill_ and works well with:

- **GitHub Copilot**
- **Cursor**
- **Claude Code**
- **OpenAI Codex**

## Installation

```bash
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription --skill alreview --skill alread --skill almerge
```

> **Note:** We recommend installing these skills globally.
>
> After installation, you need to restart your agent (start a new session) for the skills to become available.

### Configure your project (optional)

This adds `.plans` to `.gitignore` and an AlignFirst section to your `AGENTS.md` (or `CLAUDE.md`). Give your agent this prompt:

```markdown
I just installed the alignfirst skill. Help me configure it:

1. Create `.plans/` directory if it doesn't exist, and add `.plans` to `.gitignore` if needed.
2. Check if `AGENTS.md` or `CLAUDE.md` exists. If one exists, use it. If neither exists, create `AGENTS.md`. This file is our INSTRUCTION_FILE.
3. Look at our git branches (`git branch -a`) to detect our ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
   - If no pattern is found, ask me for our ticket ID format:

      > "I couldn't detect a ticket ID format from the branch names. Please provide the ticket ID format (e.g., "numeric", `ABC-###`, etc.) or type 'skip' to omit."

4. From our recent commit messages (`git log --oneline -20`), deduce the commit message convention (e.g., `<type>: [<ticket-id>] description`, `<type>(<scope>): description`, `[<ticket-id>] description`, etc.).
   - If no pattern is found, ask me for our commit message convention:

      > "I couldn't detect a commit message convention. Please describe it (e.g., `feat: [AB-123] short description`, `type(scope): description`, etc.) or type 'skip' to omit."

5. Detect the default branch with `git remote show origin | grep "HEAD branch"` (e.g., `main`, `master`, `develop`).

6. Insert the following into the INSTRUCTION_FILE (skip any part already present):
   - Add this line where it feels appropriate: "Always ignore the `.plans` directory when searching the codebase."
   - If a ticket ID format was found, add this section (include each convention line only if one was detected or provided):

   > ## AlignFirst - Ticket ID, Commit Message, Default Branch
   >
   > _Ticket ID:_ Format is `{DETECTED_FORMAT}`. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.
   >
   > _Commit message convention:_ `{DETECTED_CONVENTION}`
   >
   > _Default branch:_ `{DETECTED_DEFAULT_BRANCH}`
```

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

### Read Task Context

Load into context all specs and summaries of the current ticket:

```markdown
/alread
```

## Rationale

Specs, plans, and summaries should be written in well-organized (git-ignored) local files, because:

1. The context window is limited, the compression mechanism is opaque, and we want to be able to continue an unfinished task in a fresh session.
2. It's a way to keep track of what was agreed upon with the agent and what has been done.

## AlignFirst Coaching (experimental)

```bash
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-coaching
```

Optional environment variables:

```bash
export ALIGNFIRST_AGENT_LOG_DIR=path/to/directory # Write input/output logs
export ALIGNFIRST_AGENT_SKIP_PERMISSIONS=1        # Use --dangerously-skip-permissions instead of --permission-mode auto
```

## Upgrade from v1 or v2

1. Install the docmap skill:

   ```bash
   npx skills add https://github.com/paleo/alignfirst --skill docmap
   ```

   Then, ask your agent to install the docmap CLI:

   ```text
   Use your docmap skill. Install docmap CLI in this project.
   ```

   At the end, the agent will suggest available instructions: ignore them, we will handle that in the prompt of step 2.

2. Give your agent **[this upgrade prompt](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade.md)**.
3. Install the new alignfirst skill:

   ```bash
   npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription --skill alreview --skill alread --skill almerge
   ```

> **Note:** We recommend installing the alignfirst skills globally so they're easier to update. For the docmap skill, prefer a local/project installation.

## License

CC0 1.0 Universal.
