# AlignFirst Skill

AlignFirst enables AI agents to write the code you would write. It's distributed as an _Agent Skill_ and works well with:

- **GitHub Copilot**
- **Cursor**
- **Claude Code**
- **OpenAI Codex**

## Installation

```bash
npx skills add paleo/alignfirst --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription
```

> **Note:** We recommend installing these skills globally so they're easier to update.

Now, configure your project. Give your agent this prompt:

````markdown
I just installed the alignfirst skill. Please help me configure it:

1. Create `.plans/` directory if it doesn't exist, and add `.plans` to `.gitignore` if needed.
2. Check if `AGENTS.md` or `CLAUDE.md` exists. If one exists, use it. If neither exists, create `AGENTS.md`. This file is our INSTRUCTION_FILE.
3. Look at our git branches (`git branch -a`) to detect our ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
   - If no pattern is found, ask me for our ticket ID format:

      > "I couldn't detect a ticket ID format from the branch names. Please provide the ticket ID format (e.g., "numeric", `ABC-###`, etc.)"

4. Insert the following into the INSTRUCTION_FILE (skip any part already present):
   - Add this line: "Always ignore the `.plans` directory when searching the codebase."
   - If a ticket ID format was found, add this section:

   > ## Ticket ID
   >
   > _Ticket ID_: Format is `{DETECTED_FORMAT}`. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.
````

## Upgrade from v1 or v2

1. Install the docfront skill:

   ```bash
   npx skills add paleo/docfront --skill docfront
   ```

   Then, ask your agent to install the docfront CLI:

   ```text
   Use your docfront skill. Install docfront CLI in this project.
   ```

2. Give your agent **[this upgrade prompt](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade.md)**.
3. Install the new alignfirst skill:

   ```bash
   npx skills add paleo/alignfirst --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription
   ```

> **Note:** We recommend installing both the alignfirst and docfront skills globally so it's easier to update.

## Usage

### Align-and-Do Protocol (AAD)

A lightweight protocol for small tasks that don't need specs or plans:

```markdown
/al [something to do]
```

The agent will discuss it with you first, then work directly on the codebase. At the end, a `.plans/123/A1-AAD.summary.md` file will be written.

### Generate Technical Specification

A specification can be written long before the implementation. The agent helps you write it by investigating and initiating a discussion:

```markdown
/alspec [something to do]
```

The agent will discuss it with you, then write a `.plans/123/A1-spec.md` file.

_Note: `123` is the ticket ID. If it can be deduced from the branch name, it will be. Otherwise the agent will ask you. `A1` means it's the first file of cycle A (files are organized by cycles)._

### Generate Implementation Plan(s)

Plans orchestrate what agents or subagents will do:

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

### Generate PR/MR Description

After implementation, generate a summary of the work done, along with a commit message:

```markdown
/aldescription
```

The agent reads all specs and summaries in the task directory, then writes a concise `.plans/123/B1-description.md` file with a functional description of what was done and a Conventional Commits message.

## Additional Information

### Rationale

Specs, plans, and summaries should be written in well-organized (git-ignored) local files, because:

1. The context window is limited, the compression mechanism is opaque, and we want to be able to continue an unfinished task in a fresh session.
2. It's a way to keep track of what was agreed upon with the agent and what has been done.

### Is it "Spec-Driven Development" (SDD)?

I don't know. If you have a clue, let me know, I'm interested.


## License

CC0 1.0 Universal.
