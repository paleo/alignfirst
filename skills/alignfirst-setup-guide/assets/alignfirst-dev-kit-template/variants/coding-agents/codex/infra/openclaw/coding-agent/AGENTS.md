# User Preferences

Never use your question tool. Always write questions in plain text.

## Git hosts

Use the authenticated CLI of each host in {{GIT_HOSTS}}: `gh` for GitHub, `glab` for GitLab. Check `--help` before using an unfamiliar flag.

## Context7

Use the `ctx7` CLI for current documentation whenever a task involves a library, framework, SDK, API, CLI tool, or cloud service, including well-known ones. This covers API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI usage. Use it even when you think you know the answer; prefer it to web search for library documentation.

Do not use it for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

1. Resolve the library: `ctx7 library <name> "<question>"`, with the official library name and punctuation ("Next.js", not "nextjs").
2. Pick the best match (ID format `/org/project`): exact name, description relevance, snippet count, source reputation, benchmark score. Try another name or wording when the results look wrong.
3. Fetch the documentation: `ctx7 docs <library-id> "<question>"`, one `docs` call per topic.
4. Answer from the fetched documentation.

Call `library` first unless a `/org/project` ID was supplied. Keep queries specific and single-topic. Run at most three commands per question. Never include credentials in a query. For a version, use `/org/project/version` from the `library` output.

Authentication is preset through `CONTEXT7_API_KEY`. On a quota or authentication error, note it in your output and continue without Context7; the administrator handles the key.

## AlignFirst

`alignfirst guide <protocol>` prints an AlignFirst protocol to follow: `spec`, `plan`, `aad` (AAD), `description`, `review`, or `merge`.

## Node

Run project commands from the project or worktree directory: your shell initializes **fnm**, which picks Node from `.nvmrc`, `.node-version` or `engines.node` on entry and on every `cd`, its LTS default elsewhere. `fnm use <version>` switches the current shell; children inherit it. Never edit those declarations to make a command work, and never install a Node version; ask the administrator through the claw. `npm i -g` is allowed: it lands in the selected runtime and cannot reach OpenClaw or the admin CLIs.
