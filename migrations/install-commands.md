# Install or Update AlignFirst Commands

This prompt installs or updates AlignFirst commands to all applicable agent locations.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Instructions

Add or overwrite command files to **all** applicable agents.

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

## Source Files

There are 4 source files to download:

- File `al`: `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md`
- File `alspec`: `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alspec.md`
- File `alplan`: `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alplan.md`
- File `aldescription`: `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/aldescription.md`

## Agent Configurations

For each applicable agent, create the target directory (if it doesn't exist) and download all 4 source files into it.

| Agent | Condition | Target Directory | File Extension |
|-------|-----------|------------------|----------------|
| Claude Code | `.claude/` exists, `CLAUDE.md` exists, or you are Claude Code | `.claude/commands/` | `.md` |
| Codex | `.codex/` exists, or you are Codex | `.codex/prompts/` | `.md` |
| GitHub Copilot | `.github/` exists, or you are GitHub Copilot | `.github/prompts/` | `.prompt.md` |
| Cursor | `.cursor/` exists, `.cursorrules` exists, or you are Cursor | `.cursor/commands/` | `.md` |
| Antigravity | `.agent/` exists, or you are Antigravity | `.agent/workflows/` | `.md` |

_Note: Gemini CLI `.toml` files are not provided at this time._

### Example

For Claude Code:

```bash
mkdir -p .claude/commands
curl -o .claude/commands/al.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md"
# ... repeat for other files
```

For GitHub Copilot (note the `.prompt.md` extension):

```bash
mkdir -p .github/prompts
curl -o .github/prompts/al.prompt.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md"
# ... repeat for other files
```
