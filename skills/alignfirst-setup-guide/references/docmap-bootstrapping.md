# Bootstrapping Documentation

A reference for creating or extending project documentation by exploring the codebase.

## 1. Analyze the Codebase

Investigate the project to discover essential knowledge:

- Check if a `docs/` directory already exists. If it does, read its contents to understand what is already documented and identify gaps.
- Look for existing agent instructions, READMEs, architecture docs, and inline documentation.
- Read key source files to understand the project structure, patterns, and conventions.
- Identify areas where documentation would save time for newcomers.

## 2. Identify Document Candidates

Group related knowledge into potential documents. If docs already exist, focus on gaps and missing topics. Common types:

- **Architecture** — system overview, key abstractions, data flow.
- **Code style** — formatting, naming, patterns specific to the project.
- **Testing** — how to run tests, write new tests, test conventions.
- **Component-specific guides** — one per major module or subsystem.
- **Setup / getting started** — environment setup, first run, prerequisites.
- **Procedures** — a task an agent performs occasionally, in several ordered steps: creating a merge request, writing a changeset, cutting a release, running a migration.

Aim for 40–80 lines per document. If a topic is too broad, split it.

### Procedures belong in `docs/`, not in an entry point

An entry point is read every session; `docs/` is read on demand. A procedure earns a document when it is followed occasionally and has several steps — the reader pays for it only when the task comes up, and there is room to write it properly.

Left in `AGENTS.md` or `DEVELOPMENT.md`, the same procedure gets compressed to a command or two, which is the useless half: the agent learns that a changeset exists, but not which packages to declare, which bump to pick, or what the CI rejects. It also tends to reappear in `README.md` in a third wording, and the three copies drift.

So move the whole procedure into `docs/` and leave nothing behind — no summary line, no pointer. Docmap already indexes the document, and the `read_when` entries fire when the task arises.

### Write for the agent, not for the human's tooling

A procedure document describes the end state, not the interactive command a human would use to reach it. An agent writing a changeset file directly is faster and more accurate than an agent driving `changeset`'s prompts. Give the file format and where it goes; mention the interactive command only to say it is the human equivalent.

Include what the tooling will reject. When CI validates the artifact, state the exact constraint — a hand-written file has to satisfy a format that an interactive CLI would have produced on its own.

### Adapt every procedure to its repository

A procedure is repo-specific even when the shape is shared. Read the real values rather than copying a sibling: the git host and its CLI (`glab` vs `gh`), the base branch, the actual package names and how paths map to them, the commit convention, the pre-flight scripts that exist in `package.json`, and what CI enforces. A copied procedure that names another repository's packages is worse than no document.

## 3. Discuss with the User

Present findings and the proposed doc layout:

- List each proposed document with a tentative title and one-line summary.
- Suggest a directory structure (flat or with subdirectories).
- Get approval before writing. Adjust based on feedback.

## 4. Write the Documents

Create the `docs/` directory if it does not already exist. Follow docmap conventions:

- Use kebab-case file names, shell-safe.
- Start each file with YAML frontmatter when it adds value — especially when the filename or heading alone is not explicit enough. Frontmatter is not required; files without it fall back to the first `# heading` for the title. Only include fields that are useful: omit `summary` if the title is self-explanatory, and omit `read_when` if the document's scope is obvious.
- Keep content brief and specific to the project — no generic filler.

After writing, run `docmap --check` to verify all files pass validation.

## 5. Point agents at the essentials

In the `## Docmap - Seek Documentation` section of `AGENTS.md` (or `CLAUDE.md`), add or refresh an `### Essential Documentation` sub-list naming the 1–3 docs an agent must always read first (e.g. architecture, code style). Keep it short — it is the always-read subset, not the full index.
