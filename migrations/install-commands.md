# Install or Update AlignFirst Commands

This prompt installs or updates AlignFirst commands to all applicable agent locations.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Instructions

Overwrite AlignFirst commands to **all** applicable agent locations.
Check each of the following and download commands wherever applicable.

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly.
Do NOT fetch file contents into your context.

### Claude Code

**If** `.claude/` directory exists, OR `CLAUDE.md` file exists, OR you are Claude Code:

```bash
mkdir -p .claude/commands
```

Fetch:

- [alspec.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alspec.md) → `.claude/commands/alspec.md`
- [alplan.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alplan.md) → `.claude/commands/alplan.md`
- [al.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/al.md) → `.claude/commands/al.md`
- [aldescription.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/aldescription.md) → `.claude/commands/aldescription.md`

### Codex

**If** `.codex/` directory exists, OR you are Codex:

```bash
mkdir -p .codex/prompts
```

Fetch:

- [alspec.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alspec.md) → `.codex/prompts/alspec.md`
- [alplan.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alplan.md) → `.codex/prompts/alplan.md`
- [al.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/al.md) → `.codex/prompts/al.md`
- [aldescription.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/aldescription.md) → `.codex/prompts/aldescription.md`

### GitHub Copilot

**If** `.github/` directory exists, OR you are GitHub Copilot:

```bash
mkdir -p .github/prompts
```

Fetch (note the `.prompt.md` extension):

- [alspec.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alspec.md) → `.github/prompts/alspec.prompt.md`
- [alplan.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alplan.md) → `.github/prompts/alplan.prompt.md`
- [al.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/al.md) → `.github/prompts/al.prompt.md`
- [aldescription.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/aldescription.md) → `.github/prompts/aldescription.prompt.md`

_Note: GitHub Copilot uses the `.prompt.md` extension for prompt files._

### Cursor

**If** `.cursor/` directory exists, OR `.cursorrules` file exists, OR you are Cursor:

```bash
mkdir -p .cursor/commands
```

Fetch:

- [alspec.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alspec.md) → `.cursor/commands/alspec.md`
- [alplan.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/alplan.md) → `.cursor/commands/alplan.md`
- [al.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/al.md) → `.cursor/commands/al.md`
- [aldescription.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/v1/commands/aldescription.md) → `.cursor/commands/aldescription.md`
