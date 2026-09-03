# AlignFirst Setup

Install the AlignFirst CLI and its eight stub skills, then configure the consumer repository.
AlignFirst does not require the standalone docmap package or workspace.

## Install the CLI

Install the CLI globally on the developer's machine:

```sh
npm install -g alignfirst
```

Add `npm install -g alignfirst` to the README prerequisites so teammates install the same command.

## Install the Skills

The `alignfirst` skill runs the core guide. `alspec`, `alplan`, `al`, `almerge`, `alreview`,
`aldescription`, and `alcatchup` run individual protocols. Humans invoke them with `/` in Claude
Code, GitHub Copilot, and Cursor, or `$` in Codex.

Discover the package without installing it:

```sh
npx -y skills add https://github.com/paleo/alignfirst --list </dev/null
```

For Claude Code:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

For Codex:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

For both agents:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup </dev/null
```

Restart the target agent after installation. Use `npx -y skills update --global --yes` to update
global skills, or `npx -y skills update --project --yes` for project skills. Remove an installation
with `npx -y skills remove [--global] <skill-name> --yes`. Let the skills CLI manage
`skills-lock.json`.

## Configure the Project

1. Detect the ticket pattern from the branch and ticket conventions already visible in the
   repository:

   - Issue numbers use `^\d+$`.
   - Jira-like keys use `^[A-Z]+-\d+$`.
   - Omit the pattern when the repository has no ticket convention.

2. Run setup from the project root. Include only the applicable options:

   ```sh
   alignfirst setup --ticket-pattern '<regex>' [--plans-folder <name>] [--port-range <first>-<last>]
   ```

   The command writes `.alignfirst.json` with the compatible `cli` range, creates `.plans/`, updates
   `.gitignore`, installs the skills, and adds the README prerequisite. A second run validates the
   existing setup instead of rewriting it.

3. Detect the commit-message convention from `git log --oneline -20` and the default branch from
   the remote HEAD. Preserve repository-specific instructions and add or update this section in
   `AGENTS.md` or `CLAUDE.md`:

   ```markdown
   ## AlignFirst - Commit Message and Default Branch

   _Commit message convention:_ `{DETECTED_CONVENTION}`

   _Default branch:_ `{DETECTED_DEFAULT_BRANCH}`
   ```

   Omit a convention line when repository evidence cannot establish it. When the project uses a
   team plans repository, add this sentence under the same section:

   > After every change in `.plans/`, run `alignfirst sync`.

4. Continue with [plans-setup.md](plans-setup.md) when the team has a plans repository.

5. Run the final check:

   ```sh
   alignfirst doctor
   ```
