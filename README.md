# AlignFirst v1 (with `_docs` directory)

_Note: This is the v1 of AlignFirst (formerly Vibe Flow). If you are looking for the AlignFirst as an Agent Skill, see the [main branch](https://github.com/paleo/alignfirst)._

AlignFirst enables design-driven development with human-in-the-loop. It works well with any agent powered by a coding model such as:

- **Claude Opus 4+** or **Claude Sonnet 4+** (Anthropic)
- **GPT 5+** (OpenAI)
- **Composer 1** (Cursor)

## Get Started

1. Ensure your agent uses a capable coding model.
2. Give it [this installation prompt](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/bootstrap.md).

It will install the following structure and plug your AI instructions file into it:

```text
_docs/
├── alignfirst/
│   ├── Align-and-Do Protocol.md
│   ├── How to Write a Technical Specification.md
│   ├── How to Write Implementation Plans.md
│   └── AlignFirst Guide.md
├── Code Style Guidelines.md
├── How to Write Unit Tests.md
└── Writing Documentation.md
_plans/
AGENTS.md
```

Then, start using the workflow.

## Using AlignFirst

### Generate Technical Specification

A specification can be written long before the implementation. The agent helps you write it by investigating and initiating a discussion:

```markdown
/alspec [something to do]
```

The agent will discuss with you, then write a `_plans/123/A1-spec.md` file.

_Note: `123` is the ticket ID. If it can be deduced from the branch name, it will. Otherwise the agent will ask you. `A1` means it's the first file of cycle A (files are organized by cycles)._

### Generate Implementation Plan(s)

Plans orchestrate what agents or subagents will do:

```markdown
/alplan
```

The agent reads the spec and writes plan(s) in `_plans/123/A2-plan*.md`.

### Implementation

**Clear the context**, then execute the plan(s):

```markdown
Execute the plan `_plans/123/A2-plan-orchestrator.md`
```

The agent executes and writes handover document(s) (`.summary.md` files).

### Align-and-Do Protocol (AAD)

There is also a lighter prompt for small tasks without spec/plans. Here's how to trigger it:

```markdown
/al [something to do]
```

The agent will discuss first, then it will directly work on the codebase. At the end a `_plans/123/A1-AAD.summary.md` file will be written.

## Rationale

Specs, plans, and summaries must be written in well-organized (git-ignored) local files, because:

- We want our technical documentation to be **sustainable** and not specific to how agents work today.
- We want the same documentation to be **shared** among several agents and humans.
- We don't want to fill the **context window** with unnecessary instructions.

Everything must be written in (git-ignored) local files, because:

1. The context window is limited, the compression mechanism is opaque, and we want to be able to continue an unfinished task in a fresh session.
2. It's a way to keep track of what was agreed upon with the agent and what has been done.

## Migrations (update from older version)

Two migration prompts are available:

- [Upgrade from AI Workflow](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/migrations/upgrade-from-ai-workflow.md): replace your `_docs/ai-workflow/` directory and the instruction file with the AlignFirst directory and `AGENTS.md`.
- [Update AlignFirst](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/migrations/update-alignfirst.md): update your `_docs/alignfirst/` directory with the latest versions of the AlignFirst prompts, or upgrade from legacy `_docs/vibe-flow/`.

## License

CC0 1.0 Universal.
