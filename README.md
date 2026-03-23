# AlignFirst Skill

AlignFirst enables AI agents to write the code you would write. It's distributed as an _Agent Skill_ and works well with:

- **GitHub Copilot**
- **Cursor**
- **Claude Code**
- **OpenAI Codex**

## Installation

```bash
npx skills add paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription
```

> **Note:** We recommend installing these skills globally so they're easier to update.

Now, configure your project. This adds `.plans` to `.gitignore` and an AlignFirst section to your `AGENTS.md` (or `CLAUDE.md`). Give your agent this prompt:

````markdown
I just installed the alignfirst skill. Help me configure it:

1. Create `.plans/` directory if it doesn't exist, and add `.plans` to `.gitignore` if needed.
2. Check if `AGENTS.md` or `CLAUDE.md` exists. If one exists, use it. If neither exists, create `AGENTS.md`. This file is our INSTRUCTION_FILE.
3. Look at our git branches (`git branch -a`) to detect our ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
   - If no pattern is found, ask me for our ticket ID format:

      > "I couldn't detect a ticket ID format from the branch names. Please provide the ticket ID format (e.g., "numeric", `ABC-###`, etc.) or type 'skip' to omit."

4. From our recent commit messages (`git log --oneline -20`), deduce the commit message convention (e.g., `<type>: [<ticket-id>] description`, `<type>(<scope>): description`, `[<ticket-id>] description`, etc.).
   - If no pattern is found, ask me for our commit message convention:

      > "I couldn't detect a commit message convention. Please describe it (e.g., `feat: [#123] short description`, `type(scope): description`, etc.) or type 'skip' to omit."

5. Insert the following into the INSTRUCTION_FILE (skip any part already present):
   - Add this line where it feels appropriate: "Always ignore the `.plans` directory when searching the codebase."
   - If a ticket ID format was found, add this section (include each convention line only if one was detected or provided):

   > ## AlignFirst - Ticket ID, Commit Message
   >
   > _Ticket ID_: Format is `{DETECTED_FORMAT}`. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.
   >
   > _Commit message convention_: `{DETECTED_CONVENTION}`
````

> **Note (2026-03-09):** On Cursor, to make the skills available as commands (using `/`), I had to create a symlink: `cd ~/.cursor/ && ln -s ../.agents/skills .`

## Upgrade from v1 or v2

1. Install the docfront skill:

   ```bash
   npx skills add paleo/docfront --skill docfront
   ```

   Then, ask your agent to install the docfront CLI:

   ```text
   Use your docfront skill. Install docfront CLI in this project.
   ```

   At the end, the agent will suggest available instructions: ignore them, we will handle that in the prompt of step 2.

2. Give your agent **[this upgrade prompt](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade.md)**.
3. Install the new alignfirst skill:

   ```bash
   npx skills add paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription
   ```

> **Note:** We recommend installing the alignfirst skills globally so they're easier to update. For the docfront skill, prefer a local/project installation.

## Usage

### Specification

A technical specification can be written long before the implementation. The agent helps you write it by investigating and initiating a discussion:

```markdown
/alspec [something to do]
```

The agent will discuss it with you, then write a `.plans/123/A1-spec.md` file.

_Note: `123` is the ticket ID. If it can be deduced from the branch name, it will be. Otherwise the agent will ask you. `A1` means it's the first file of cycle A (files are organized into cycles)._

### Plan(s)

Implementation plans orchestrate what agents or subagents will do:

```markdown
/alplan
```

The agent reads the spec and writes a plan `.plans/123/A2-plan.md`, or a main plan `.plans/123/A2-main-plan.md` with several sub-plans.

### Implementation

**Clear the context**, then execute the plan(s):

```markdown
Execute the plan `.plans/123/A2-main-plan.md`
```

The agent executes the plan and writes `.summary.md` files.

### Align-and-Do Protocol (AAD)

A lightweight protocol for small tasks that don't need specs or plans:

```markdown
/al [something to do]
```

The agent will discuss it with you first, then work directly on the codebase. At the end, a `.plans/123/A1-AAD.summary.md` file will be written.

### PR/MR Description

Generate a summary of the work done, using all specs and summaries in the task directory:

```markdown
/aldescription
```

The agent writes a `.plans/123/B1-description.md` file with a short description of what was done and a Conventional Commits message.

## Rationale

Specs, plans, and summaries should be written in well-organized (git-ignored) local files, because:

1. The context window is limited, the compression mechanism is opaque, and we want to be able to continue an unfinished task in a fresh session.
2. It's a way to keep track of what was agreed upon with the agent and what has been done.

## License

CC0 1.0 Universal.
