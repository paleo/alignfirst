# AlignFirst Skills Setup

Configure a consumer repo for the AlignFirst skills: add `.plans` to `.gitignore` and an AlignFirst section to the instruction file.

## Step 1 — Configure the project

1. Create the `.plans/` directory if it doesn't exist, and add `.plans` to `.gitignore` if needed.
2. Check if `AGENTS.md` or `CLAUDE.md` exists. If one exists, use it. If neither exists, create `AGENTS.md`. This file is the INSTRUCTION_FILE.
3. Look at git branches (`git branch -a`) to detect the ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
   - If no pattern is found, ask the user:

      > "I couldn't detect a ticket ID format from the branch names. Please provide the ticket ID format (e.g., "numeric", `ABC-###`, etc.) or type 'skip' to omit."

4. From recent commit messages (`git log --oneline -20`), deduce the commit message convention (e.g., `<type>: [<ticket-id>] description`, `<type>(<scope>): description`, `[<ticket-id>] description`, etc.).
   - If no pattern is found, ask the user:

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

## Step 2 — Install the skills

Can you see the `alignfirst` skill? If the skills are not already installed, then ask the user to install them. **Print this command without executing it** so the user can run it themselves:

```text
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst --skill al --skill alplan --skill alspec --skill aldescription --skill alreview --skill alread --skill almerge
```

We recommend installing these skills globally. After installation, the user must restart their agent (new session) for the skills to load.
