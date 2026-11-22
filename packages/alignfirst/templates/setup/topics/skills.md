# Install the Skills

The skills invoke the CLI through `{{CMD}}`; they need no separate CLI installation. For a skills-only request, install the skills and leave the project unchanged. Configure the project only when the user also wants the repository to adopt AlignFirst (`{{CMD}} setup guide protocols`).

When preparing a project for an assistant, skip the skills and the global bootstrap line; see `{{CMD}} setup guide assistant-project`.

## The skills

- `alspec`, `alplan`, `al`, `almerge`, `alreview` and `aldescription` select one protocol each.
- `alcatchup` loads the ticket history. `alcatchupaad` and `alcatchupspec` load it before starting AAD or a specification.
- `aligndev` turns the session into an AlignFirst assistant that delegates coding to agent sessions. Install it with the command skills by default. Omit `--skill aligndev` only when the user declines it.
- `alignfirst`, optional, lets the agent recognize a protocol named in prose. Add `--skill alignfirst` when the user wants that recognition in repositories without the `alignfirst context` bootstrap section. Where that section exists, the skill is unnecessary.
- `paseo-alignfirst-workspace`, optional, drives the Paseo lifecycle; see `{{CMD}} setup guide paseo`.

The command skills keep `disable-model-invocation: true`: only a human invokes them. Humans type `/name` in Claude Code, GitHub Copilot and Cursor, `$name` in Codex, and `/skill:name` in Pi, such as `/skill:alspec`. Skills reuse the guides already in context, and each named guide includes the ticket directory and work-file rules.

## Availability

The report's global skills line shows what is installed on disk. The session's skill list shows what is available in this session: a name missing from the list is unavailable here, even when it is on disk. When the host exposes no list, availability is unknown. This check needs no filesystem scan and no installer.

## Install

The skills are installed globally only. With the user's approval, run:

```sh
{{SKILLS_INSTALL}}
```

Replace `<host>` with the user's coding host: `claude-code`, `codex` or `pi`. Repeat `--agent` for several hosts, as in `--agent claude-code --agent codex`. To list the package's skills without installing them:

```sh
npx -y skills add https://github.com/paleo/alignfirst --list </dev/null
```

When a global installation fails for lack of write access, report it once and continue without the skills. Never fall back to another location. On an AlignDev OpenClaw host, the service account's skill directories are admin-owned and locked, by design.

Restart the target agent after installation. Update the skills with `npx -y skills update --global --yes`. Remove one with `npx -y skills remove --global <skill-name> --yes`.

## Pi

Pi discovers the global `~/.agents/skills/`, where the installer writes. It also discovers `<agent-dir>/skills`, by default `~/.pi/agent/skills`; `PI_CODING_AGENT_DIR` replaces the agent directory. Target layouts can change: confirm them in the current help or source when upgrading. Stock Pi invokes `/skill:alspec`, not `/alspec`.

`{{CMD}} doctor` checks the global skill roots in order. It keeps the first installation found and deduplicates canonical roots. It reports missing command skills once any is installed, and warns about old or unknown versions. The `PI_CODING_AGENT_DIR` override accepts `~`, `~/`, absolute or relative paths and native file URLs. An empty override selects the default. A nonempty path keeps its whitespace and expands neither variables nor `~otheruser`. The check also excludes ancestor resources.

A skill alone supplies no executable Pi tools. Preserve duplicate-tool audits and the native trust and permission policies.

### Optional Pi subagents

For a direct AlignFirst user who requests isolated plan or review delegation, offer `pi install npm:@alignfirst/pi-subagent` as a separate executable capability. Without a subagent tool, the protocols keep their host-neutral fallback. A skills-only request installs no extensions. The generic background package is unnecessary for synchronous delegation.

Before replacing an existing local `subagent` extension, obtain approval and disable it explicitly with `pi config`. Keep its profiles, and never load both tools. `/reload` cancels active subagents and background jobs.

Install the current stable package and inspect its declared Pi peer and Node runtime compatibility. It preserves Pi's normal project-trust discovery, without forced approval. See [the package README](https://github.com/paleo/alignfirst/blob/main/packages/pi-subagent/README.md).
