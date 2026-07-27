# Environment

You run **natively** on `myclaw-host` (Ubuntu 24.04) as the unprivileged Linux user `myclaw`. No Docker container around you. You have **no sudo**.

The dev servers of those projects bind to ports in **6500–7700**, which UFW opens only to the team VPN IP.

## What you can't do

- **No sudo, no apt.** If you need a system package, ask `myclaw-adm`.
- **No skill installation from ClawHub.** Your skill allowlist is fixed (`agents.defaults.skills` in `openclaw.json`); the `clawhub` skill is intentionally absent. To add a new skill, ask `myclaw-adm`.

## What you can do

- **Docker.** You're in the `docker` group, so `docker` and `docker compose` work without sudo. Use this to start/stop the dev stacks of the projects you manage. Be deliberate — `docker` group is effectively root on the host; do not mount unexpected paths or run untrusted images.
- **Node.** At `/usr/bin/node`, with **npm** and **pnpm**.
- **Git / GitHub.** `git` uses an SSH key at `~/.ssh/id_ed25519` registered to the `myclaw-bot` GitHub account. `gh` is authenticated via device flow — use it for PRs, issues, comments.
- **Browser automation (Playwright).** OpenClaw's browser plugin uses Playwright with a downloaded headless Chromium at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`. Headless by default — no Xvfb, no `--no-sandbox` flag needed. Use `page.pdf()` for HTML → PDF (don't reach for `wkhtmltopdf`; it's not installed).
- **Claude Code.** `claude` CLI is installed and has its own auth (separate from your Anthropic API key). Use it for coding tasks when appropriate.
- **CLI tools.** Beyond the basics (`bash`, `git`, `curl`, `wget`, `ssh`, `python3`, `vim`, `nano`, `jq`, `rg`, `dig`):
  - search/nav: `fd`, `tree`, `ncdu`, `bat`
  - data: `yq`, `sqlite3`, `psql` (remote Postgres only — local DBs live in containers, reach them via `docker exec`)
  - HTTP: `http`/`https` (httpie)
  - images: `vips`, `cwebp`/`dwebp`, `rsvg-convert`; or `sharp` from Node
  - PDF: `pdftotext`, `pdftoppm`, `pdfinfo`, `qpdf`
  - OCR: `tesseract -l fra+eng`
  - archives: `zip`, `unzip`, `7z`, `xz`, `zstd` (plus base `tar`, `gzip`, `bzip2`)
  - media/docs: `ffmpeg`, `pandoc`
  - shell quality: `shellcheck`, `shfmt`
  - native build: `gcc`/`g++`/`make` (for npm packages with native bindings)

## Cross-surface messaging — the `message` tool

OpenClaw's auto-streaming posts your normal model text to your bound surface (the channel or thread). For everything else — opening a thread on demand, posting into a different surface than your binding, reading a thread's history, attachments, reactions — use the `message` tool. Cross-channel actions go through this tool's actions, not raw API calls.

The IDs you need come from the inbound conversation metadata in your prompt: `chat_id` (e.g. `channel:1500…`), `message_id` (the user's triggering message), `group_space` (the Discord guild ID).

**Recipient target format.** Pass `target` exactly as the `chat_id` reads — keep the prefix. For Discord: `"channel:<id>"` for channels and threads, `"user:<id>"` or `"<@id>"` for DMs. Without the prefix the tool errors `Ambiguous Discord recipient "<id>"`.

### Open a Discord thread on the user's message

```jsonc
// message tool call
{
  "action": "thread-create",
  "channel": "<channel>",
  "target": "<chat_id from inbound metadata>",
  "messageId": "<message_id of the user's triggering message>",
  "threadName": "<TICKET_ID> - <PROJECT> - <1-to-5-word description>",
  "message": "<starter content — the bot's first post in the new thread>",
  "autoArchiveMin": 1440
}
```

The result contains the new thread's ID. Reuse that as `threadId` for subsequent posts.

### Post into a thread (or back into the parent channel)

```jsonc
{
  "action": "thread-reply",
  "channel": "<channel>",
  "threadId": "<thread id from thread-create>",
  "message": "Next progress update."
}
```

For posting back into the parent channel from within a thread, use `action: "send"` with the channel target.

### Rename an existing thread

There is no rename action: the new name rides on a post, as `threadName`.

```jsonc
{
  "action": "thread-reply",
  "channel": "<channel>",
  "threadId": "<thread id>",
  "threadName": "<TICKET_ID> - <PROJECT> - <1-to-5-word description>",
  "message": "<the line you were going to post anyway>"
}
```

### Read prior messages in a thread (Discord-only quirk)

Discord thread sessions start with an **empty transcript** even when the thread already has messages from the channel session that opened it (this is upstream issue #52112 — Slack's `ThreadHistoryBody` injection has no Discord equivalent). When a fresh thread session activates on a user follow-up, recover context with:

```jsonc
{
  "action": "read",
  "channel": "<channel>",
  "threadId": "<your bound thread id>",
  "limit": 50
}
```

The tool returns prior thread messages newest-first; the agent system prompt's `MESSAGE_TOOL_THREAD_READ_HINT` already nudges you to do this when you lack context.

### File uploads and reactions

```jsonc
{ "action": "sendAttachment", "channel": "<channel>", "target": "<channel-or-thread-id>", "filePath": "/path/to/image.png", "message": "" }
{ "action": "react", "channel": "<channel>", "target": "<channel-or-thread-id>", "messageId": "<message-id>", "emoji": "👀" }
```

## Where to write files

- **Ephemeral artifacts** — screenshots, downloads, OCR/PDF scratch, temporary conversion outputs, anything not part of a project — go under `~/scratch/`. Subdivide if helpful (`~/scratch/screenshots/`, `~/scratch/downloads/`), flat is fine for low volume. Files there persist across reboots so the human can fetch them later, and the administrator will prune the directory periodically.
- **Project files** belong inside the relevant `~/projects/<repo>/`, tracked by Git. Never drop scratch artifacts there — it dirties the working tree and is easy to accidentally commit.
- **Your workspace files** (`~/.openclaw/workspace/`) are reserved for the curated personality files (`AGENTS.md`, `IDENTITY.md`, etc.). Don't write artifacts there.
- `/tmp/` is fine only for files you genuinely don't care about losing.
