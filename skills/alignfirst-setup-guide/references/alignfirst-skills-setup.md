# AlignFirst Skills Setup

Install the AlignFirst content skill and seven human command skills, then configure the consumer
repository. AlignFirst does not require docmap or workspace.

## Skill Model

`alignfirst` contains the protocols. `alspec`, `alplan`, `al`, `almerge`, `alreview`,
`aldescription`, and `alread` are human-invoked commands with `disable-model-invocation: true`.
Repository discovery still lists all eight directories.

Humans invoke commands with `/`, such as `/alspec`, in Claude Code, GitHub Copilot, and Cursor. Codex
uses `$`, such as `$alspec`.

## Configure the Project

1. Create `.plans/` when absent and ensure `.gitignore` contains `.plans`.
   - When upgrading from `.plans/**`, `!.plans/**/`, and `!.plans/**/*.shared.md`, replace that block
     with `.plans`. Untrack committed `*.shared.md` files with `git rm --cached` and report them.
2. Use the existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` when neither exists.
3. Detect the ticket format from `git branch -a`, the commit convention from
   `git log --oneline -20`, and the default branch from the remote HEAD. Ask only for a convention
   that repository evidence cannot establish; allow the user to omit it.
4. Extend the existing code-search ignore instruction with `.plans`.
5. Add or update this section with the detected values. Omit convention lines without a value.

   ```markdown
   ## AlignFirst - Ticket ID, Commit Message, Default Branch

   _Ticket ID:_ Format is `{DETECTED_FORMAT}`. Use the ticket ID if explicitly provided. Otherwise,
   deduce it from the current branch name without confirmation. If unavailable, run
   `git branch --show-current`. Ask the user only as a last resort.

   _Commit message convention:_ `{DETECTED_CONVENTION}`

   _Default branch:_ `{DETECTED_DEFAULT_BRANCH}`
   ```

Preserve repository-specific instructions and adapt the heading when the project already uses an
equivalent conventions section.

## Install the Skills

When installation is requested, run the matching command. Global symlink-based installation is the
default because the commands are reusable across repositories. Omit `--global` for an explicitly
project-local installation. Add `--copy` only where symlinks are unsuitable.

Discover the package without installing it:

```sh
npx -y skills add https://github.com/paleo/alignfirst --list </dev/null
```

For Claude Code:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alread </dev/null
```

For Codex:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alread </dev/null
```

For both agents:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alread </dev/null
```

Restart the target agent after installation. Use `npx -y skills update --global --yes` to update
global skills, or `npx -y skills update --project --yes` for project skills. Remove an installation
with `npx -y skills remove [--global] <skill-name> --yes`. Let the CLI manage `skills-lock.json`.

## Team Plans Repository

`.plans/` stays local by default. When the team has a dedicated plans repository, continue with
[plans-share-setup.md](plans-share-setup.md). The AlignFirst skills behave identically in both modes.
