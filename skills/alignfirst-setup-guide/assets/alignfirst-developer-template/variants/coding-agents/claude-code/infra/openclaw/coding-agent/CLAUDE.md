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
