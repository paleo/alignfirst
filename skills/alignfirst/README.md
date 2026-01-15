# AlignFirst Skill

AlignFirst skill is a spec-driven development workflow for AI agents.

## Post-Install Setup

After installing this skill, run the following prompt to configure your project:

**Prompt to run:**

```markdown
I just installed the alignfirst skill. Please help me configure it:

1. Look at my git branches (`git branch -a`) to detect my ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
2. If you find a pattern, add this section to my `AGENTS.md`:

   ## Ticket ID

   _Ticket ID_: Format is `{DETECTED_FORMAT}`. When not provided, deduce it from the branch name if possible—no need to confirm.

3. If no pattern is found, ask me for my ticket ID format.
4. Ensure `AGENTS.md` contains: "Always ignore the `_plans` directory when searching the codebase."
5. Create `_plans/.gitkeep` if it doesn't exist.
6. Add `_plans/*` and `!_plans/.gitkeep` to `.gitignore` if needed.
```

This setup enables AlignFirst to automatically detect ticket IDs from your branch names.

## Using AlignFirst

### Generate Technical Specification

A specification can be written long before the implementation. The agent helps you write it by investigating and initiating a discussion:

```markdown
/alspec [something to do]
```

The agent will discuss with you, then write a `_plans/123/A1-spec.md` file.

_Note: `123` is the ticket ID. If it can be deduced from the branch name, it will. Otherwise the agent will ask you._

### Generate Implementation Plan(s)

Plans orchestrate what agents or subagents will do:

```markdown
/alplan
```

The agent reads the spec and write a plan `_plans/123/A2-plan.md`, or a main plan `_plans/123/A2-main-plan.md` with several sub-plans.

### Implementation

**Clear the context**, then execute the plan(s):

```markdown
Execute the plan `_plans/123/A2-main-plan.md`
```

The agent executes and writes `.summary.md` files.

### Align-and-Do Protocol (AAD)

A lighter workflow for small tasks without spec/plans:

```markdown
/al [something to do]
```

The agent will discuss first, then work on the codebase, and write a summary.
