# Install or Update AlignFirst Commands

This prompt installs or updates AlignFirst commands to all applicable agent locations.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Instructions

This prompt installs AlignFirst commands to all detected agent directories in your workspace.

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

## Step 1 - Detect Agent Directories

Check which of the following directories or files exist in the repository root:

- `.claude/` directory or `CLAUDE.md` file
- `.codex/` directory
- `.github/` directory
- `.cursor/` directory or `.cursorrules` file
- `.agent/` directory

**Decision:**

- Install commands to **all detected agent directories** (multiple installations are expected).
- **Additionally**, if you know which agent you are (Claude Code, Codex, GitHub Copilot, Cursor, or Antigravity), also install commands for your own agent—even if its directory doesn't exist yet.
- If you don't know which agent you are and no directories exist, ask the user which agent(s) to install for.

## Step 2 - Source Files

There are 4 source files to download:

- `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md`
- `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alspec.md`
- `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alplan.md`
- `https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/aldescription.md`

## Step 3 - Install Commands

For **each detected agent directory**, create the target directory (if it doesn't exist) and download all 4 source files into it.

| Agent | Target Directory | File Extension |
|-------|------------------|----------------|
| Claude Code | `.claude/commands/` | `.md` |
| Codex | `.codex/prompts/` | `.md` |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` |
| Cursor | `.cursor/commands/` | `.md` |
| Antigravity | `.agent/workflows/` | `.md` |

_Note: Gemini CLI `.toml` files are not provided at this time._

## Examples

### Example 1: If Claude Code is detected

```bash
mkdir -p .claude/commands
curl -o .claude/commands/al.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md"
curl -o .claude/commands/alspec.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alspec.md"
curl -o .claude/commands/alplan.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alplan.md"
curl -o .claude/commands/aldescription.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/aldescription.md"
```

### Example 2: If GitHub Copilot is detected

**For GitHub Copilot** (note the `.prompt.md` extension):

```bash
mkdir -p .github/prompts
curl -o .github/prompts/al.prompt.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/al.md"
curl -o .github/prompts/alspec.prompt.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alspec.md"
curl -o .github/prompts/alplan.prompt.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/alplan.md"
curl -o .github/prompts/aldescription.prompt.md "https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/commands/aldescription.md"
```

## Done

After installing commands to all detected agent directories, inform the user which agents were configured and where the commands were installed.
