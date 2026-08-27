#!/usr/bin/env bash
#
# Coding-agent seed module: Claude Code. Sourced by seed.sh; not meant to run on its own.
# The agent is selected by the overlay (environment.d/coding-agent.conf), not by .env.

required_coding_agent=()

validate_coding_agent() {
  if ! command -v claude >/dev/null 2>&1; then
    echo "[seed] Claude Code is not installed for $(id -un): see 08-coding-agent.md#install." >&2
    exit 1
  fi
}

configure_coding_agent() {
  echo "[seed] Claude Code global instructions — ~/.claude/CLAUDE.md"
  merge_managed_block "$HOME/.claude/CLAUDE.md" "$DIR/coding-agent/CLAUDE.md" alignfirst-developer
}
