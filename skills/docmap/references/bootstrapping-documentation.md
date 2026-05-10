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

Aim for 40–80 lines per document. If a topic is too broad, split it.

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
