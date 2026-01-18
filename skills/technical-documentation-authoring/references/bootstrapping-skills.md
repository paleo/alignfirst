# Bootstrapping Agent Skills

Guide for creating Agent Skills in a project with little or no existing documentation.

## Step 1: Analyze the Codebase

Investigate the codebase to discover essential knowledge that helps an AI agent be immediately productive.

Search for existing AI conventions:

```
**/{.github/copilot-instructions.md,AGENT.md,AGENTS.md,CLAUDE.md,GEMINI.md,.cursorrules,.windsurfrules,.clinerules,.cursor/rules/**,.windsurf/rules/**,.clinerules/**,.agent/rules/**,README.md}
```

Focus on:

- **Architecture**: Major components, service boundaries, data flows, structural decisions
- **Developer workflows**: Build, test, debug commands—especially non-obvious ones
- **Conventions and patterns**: Project-specific approaches that differ from common practices
- **Integration points**: External dependencies, cross-component communication

## Step 2: Identify Skill Candidates

Group related knowledge into potential skills. Each skill should cover one focused topic.

Common skill types:

- `code-style` — formatting, naming, idioms
- `testing` — test framework, patterns, commands
- `work-on-{component}` — component-specific knowledge (e.g., `work-on-backend`, `work-on-frontend` if the codebase has server/client separation)
- `architecture` — system structure, key abstractions

## Step 3: Discuss with the User

Present your findings and proposed skill list to the user before writing anything.

- Share what you discovered about the codebase
- Propose which skills to create and their scope
- Ask clarifying questions about priorities
- The user knows the project best—collaborate to refine the plan
- Agree on 2–3 skills to start with (you can add more later)

## Step 4: Write the Skills

Only after user approval, write the agreed-upon skills following the Writing Guidelines for documentation authoring.
