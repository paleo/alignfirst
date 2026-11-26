# Bootstrap Documentation

Create or extend the project's documentation by exploring the codebase. The examples use `{{CMD}} docmap`; use the project's Docmap command (`{{CMD}} setup guide docmap`).

## 1. Analyze the codebase

Investigate the project to discover its essential knowledge:

- When `docs/` exists, read it to learn what is already documented and find the gaps.
- Look for existing agent instructions, READMEs, architecture documents and inline documentation.
- Read key source files to understand the project's structure, patterns and conventions.
- Identify the areas where documentation would save a newcomer time.

## 2. Identify document candidates

Group related knowledge into candidate documents. When documentation exists, focus on gaps and missing topics. Common types:

- **Architecture**: system overview, key abstractions, data flow.
- **Code style**: formatting, naming and patterns specific to the project.
- **Testing**: how to run tests, write new ones, and the test conventions.
- **Component guides**: one per major module or subsystem.
- **Setup**: environment setup, first run, prerequisites.
- **Procedures**: a task an agent performs occasionally, in several ordered steps, such as creating a merge request, writing a changeset, cutting a release or running a migration.

Aim for 40 to 80 lines per document. Split a topic that is too broad.

### Procedures belong in `docs/`

An entry point is read every session; `docs/` is read on demand. A procedure earns a document when it is followed occasionally and has several steps: the reader pays for it only when the task comes up, and there is room to write it properly.

Left in `AGENTS.md` or `ASSISTANTS.md`, the same procedure gets compressed to a command or two, which is the useless half. The agent learns that a changeset exists, but not which packages to declare, which bump to pick, or what the CI rejects. The procedure also tends to reappear in `README.md` in a third wording, and the three copies drift.

Move the whole procedure into `docs/` and leave nothing behind: no summary line, no pointer. Docmap already indexes the document, and its `read_when` entries fire when the task arises.

### Write for the agent

A procedure document describes the end state, not the interactive command a human would use to reach it. An agent that writes a changeset file directly is faster and more accurate than one driving the prompts of `changeset`. Give the file format and its location. Mention the interactive command only as the human equivalent.

State what the tooling rejects. When CI validates the artifact, give the exact constraint: a hand-written file must satisfy the format an interactive CLI would have produced on its own.

### Adapt every procedure to its repository

A procedure is specific to its repository, even when its shape is shared. Read the real values instead of copying a sibling: the Git host and its CLI (`glab` or `gh`), the base branch, the package names and how paths map to them, the commit convention, the pre-flight scripts in `package.json`, and what CI enforces. A copied procedure that names another repository's packages is worse than no document.

## 3. Discuss with the user

Present the findings and the proposed layout:

- Each proposed document, with a tentative title and a one-line summary.
- A directory structure, flat or with subdirectories.

Obtain approval before writing, and adjust to the feedback.

## 4. Write the documents

Create `docs/` when it is missing. Follow the conventions of `{{CMD}} docmap --guide`. Add `read_when` only when the document's scope is not obvious.

After writing, run `{{CMD}} docmap --check` and fix every reported file.

## 5. Point agents at the essentials

In the documentation section of `AGENTS.md` or `CLAUDE.md`, add or refresh an `### Essential Documentation` sub-list naming the 1 to 3 documents an agent must always read first, such as the architecture and the code style. The section is the one `{{CMD}} setup guide docmap` selects: the standalone Docmap section or the AlignFirst bootstrap section. Keep the list short: it is the always-read subset, not the full index.
