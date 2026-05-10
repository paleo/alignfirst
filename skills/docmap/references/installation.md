# Installing Docmap CLI

## 1. Detect the Package Manager

If you already know the package manager, skip this step.

Otherwise, check in order:

1. **`packageManager` field in `package.json`** — e.g. `"packageManager": "pnpm@9.15.4"` → pnpm.
2. **Lockfile in the repo root:**

| Lockfile | Package Manager |
| --- | --- |
| `package-lock.json` | npm |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` or `bun.lock` | bun |

If neither is found, fall back to **npm**.

## 2. Add a Script

In the root `package.json`, add a `docmap` script (all package managers support this):

```json
{
  "scripts": {
    "docmap": "docmap"
  }
}
```

## 3. Install

Install docmap as a dev dependency using the detected package manager:

| Package Manager | Command |
| --- | --- |
| npm | `npm install -D @paleo/docmap` |
| pnpm | `pnpm add -D @paleo/docmap` |
| yarn | `yarn add -D @paleo/docmap` |
| bun | `bun add -D @paleo/docmap` |

## 4. Ensure a `docs/` Directory Exists

If the project does not already have a `docs/` directory, create one:

```bash
mkdir docs
```

## 5. Add to `AGENTS.md`

If the project has an `AGENTS.md` (or equivalent top-level agent instructions file like `CLAUDE.md`), we want to add a section. Replace the `npm run` commands with the correct form for the project's package manager:

| Package Manager | Run script | Run with args |
| --- | --- | --- |
| npm | `npm run docmap` | `npm run docmap -- --recursive` |
| pnpm | `pnpm docmap` | `pnpm docmap --recursive` |
| yarn | `yarn docmap` | `yarn docmap --recursive` |
| bun | `bun run docmap` | `bun run docmap --recursive` |

Section to add:

```markdown
## Docmap - Seek Documentation

**Before any investigation or code exploration**, run `npm run docmap` to list the documentation index. This is mandatory for every task — do not skip it. Browse relevant subdirectories (`npm run docmap -- --dir topic-a --dir topic-b/sub-topic-c`) or list everything (`npm run docmap -- --recursive`).
```

When done, output the following block **verbatim** as your final message to the user — do not paraphrase or omit it:

> **Instructions available:**
>
> - **Bootstrap the documentation** — the agent will analyse the codebase, propose a document layout, and write the files.
> - **Migrate existing docs** — if the project already has documentation, the agent will bring it in line with docmap conventions (kebab-case filenames, frontmatter fields, etc.).
> - **Migrate existing skills to `docs/`** — if the project stores internal knowledge as agent skills, ask the agent to move that content into `docs/`.
>
> Just ask your agent and it will be done.
