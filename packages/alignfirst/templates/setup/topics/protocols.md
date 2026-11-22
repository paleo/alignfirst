# Adopt the Protocols

The protocols run through the CLI. They need neither the skills nor Docmap nor a workspace. Project files invoke the CLI as `{{CMD}}`, which requires no installation, so the project works on a machine that has never installed AlignFirst.

For a protocols-only request, skip the skills. For the skills, run `{{CMD}} setup guide skills`.

## 1. Settle the conventions

The report lists the configured conventions or, when none are configured, the branch names and commit subjects to read them from. When that evidence is too thin, read more with `git branch --all` and `git log --oneline -20`.

- **Ticket IDs.** Take the pattern from branch names and ticket references: `^\d+$` for issue numbers, `^[A-Z]+-\d+$` for Jira-like keys. The pattern is one anchored expression. Alternatives go inside a group, as in `^(ABC|XYZ)-\d+$`.
- **Branch names.** Take the template from existing branches, such as `{TICKET_ID}/{slug-1-3-words}`.
- **Commits.** The supported style is conventional commits. The ticket reference is `bracketed` for `type: [TICKET_ID] summary` or `bracketedHash` for `type: [#TICKET_ID] summary`. Without a ticket reference, subjects are `type: summary`.
- **Default branch.** The report prints the branch Git resolves. When it is unresolved, run `git ls-remote --symref origin HEAD`. Use the sole remote when `origin` is absent, and ask the user when several other remotes exist.

When evidence is missing or unclear, ask the user to confirm the conventions before writing them. Suggest this baseline: numeric ticket IDs, `main`, `{TICKET_ID}/{slug-1-3-words}` branches, conventional commits with `bracketedHash` ticket references, and no agent attribution. Preserve established conventions. Leave a field out only when the user chooses to leave it unspecified.

Conventions written in the instruction file move into the configuration. Remove them from the prose afterward.

## 2. Run `setup init`

Run one command from the main-worktree root, with the settled conventions. The baseline gives:

```sh
{{CMD}} setup init \
  --ticket-pattern '^\d+$' \
  --default-branch main \
  --branch-template '{TICKET_ID}/{slug-1-3-words}' \
  --commit-style conventionalCommit \
  --commit-ticket-reference bracketedHash \
  --no-agent-coauthoring
```

| Flag | Effect |
| --- | --- |
| `--ticket-pattern <regex>` | `conventions.ticketIdPattern` |
| `--default-branch <name>` | `conventions.git.defaultBranch` |
| `--branch-template <template>` | `conventions.git.branchNameTemplate` |
| `--commit-style conventionalCommit` | `conventions.git.commit.style` |
| `--commit-ticket-reference <reference>` | `conventions.git.commit.ticketReference`, `bracketed` or `bracketedHash`; requires `--commit-style` |
| `--no-agent-coauthoring` | `conventions.git.agentCoauthoring: false`: no coding-agent attribution in commits |
| `--plans-folder <name>` | `plans.repositoryFolder`: the project's folder in a work-files repository |
| `--default-location`, `--item` | Register a companion first; see `{{CMD}} setup guide companion` |
| `--git-exclude` | Write ignore rules root-anchored to `.git/info/exclude` instead of `.gitignore` |
| `--no-instructions` | Leave `AGENTS.md` and `CLAUDE.md` untouched |

The command is idempotent. It validates everything before the first change, then prints one line per step, with `created`, `updated`, `unchanged` or `skipped`:

1. **Companion.** Registers the companion when `--default-location` is given.
2. **Configuration.** Writes `alignfirst.json` when the selected location holds no configuration file: `schemaVersion: 1`, the conventions given as flags, and `plans` with `autoArchive: true`. A flag left out leaves its field out. An existing configuration stays unchanged, and the command warns about the flags it did not apply; edit the file by hand instead (`{{CMD}} setup guide configuration`).
3. **Work files.** Creates the effective `.plans` directory when it is missing. Plans tracked by the product repository fail this step; see `{{CMD}} setup guide work-files`.
4. **Ignore rules.** Ignores `.plans` when it resolves inside the project, and `.local-wt/` when the workspace runtime is project-local, each only when Git does not already ignore it.
5. **Instructions.** Inserts the bootstrap section, as `{{CMD}} setup instructions --write` does.

When the team has a work-files repository, continue with `{{CMD}} setup guide work-files`.

## 3. Project instructions

The bootstrap section in `AGENTS.md` or `CLAUDE.md` makes every session start with `{{CMD}} context`, which prints the conventions, the documentation map and the protocols. It works with or without a configuration file. `{{CMD}} setup instructions` reports its status and prints the canonical text.

| Status | Action |
| --- | --- |
| `absent` | Run `{{CMD}} setup instructions --write`. It inserts the section before the first `##` heading, after the title and introduction, in `AGENTS.md`, else in an existing `CLAUDE.md`, else in a new `AGENTS.md`. `--file <path>` selects another target. |
| `current` | Nothing. |
| `differs` | Edit the section by hand so that its heading and its command paragraph match the canonical text. Keep the project's additions in the section. |
| `ambiguous` | Several sections mention `alignfirst context`, or a mention sits outside a `##` section. Merge them into one canonical section at one of the listed locations. |
| `global` | The companion keeps the repository free of the section; see `{{CMD}} setup guide companion`. |

The command also reports a legacy `Docmap - Seek Documentation` section. Replace it with the bootstrap section, which supplies the documentation map. Keep its essential-documentation list and project-specific rules under the bootstrap section.

The bootstrap section is enough for the default AlignFirst guidance. Remove what the CLI already supplies: redundant protocol instructions, generic workspace-readiness text, workspace-guide pointers and search exclusions. Preserve project-specific rules and any convention the configuration does not represent.

## Local installation

By default, a project declares no `alignfirst` dependency. Add one only when the user requests a local CLI, or when the repository's publication-age or provenance gates require a local dependency.

Install the current stable `alignfirst` as a dev dependency with the project's package manager, honoring its dependency policy. The CLI includes the Docmap and workspace kernel dependencies: apply the installation gates to its complete dependency tree. Install dependencies before invoking it. The bootstrap section keeps its command, which resolves the local binary. No package script is required.

## Check

```sh
{{CMD}} config
{{CMD}} doctor
```

The configuration format is in `{{CMD}} setup guide configuration`.
