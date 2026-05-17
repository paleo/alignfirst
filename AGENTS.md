# Repository Guidelines

**Important:** Every text in this repository must be sharp, concise, straight to the point. Each word must be carefully weighted and chosen.

**Writing Markdown**: Do not wrap text to 80 chars; let it run freely.

## AlignFirst - Ticket ID, Commit Message, Branch Name

_Ticket ID_: Format is numeric. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.

Commit message convention: we use conventional commit, e.g., `feat: [#123] add new feature`. Always prefix the ticket ID with a `#` sign. Do not add a "Co-Authored-By:" line.

Branch naming convention: `<type>/<ticket-id>` (with type from conventional commit, e.g., `feat/123`, `fix/123`, `refactor/123`, `chore/123`).

Add `docs/code-style.md` and `docs/code-quality.md` to every plan.
