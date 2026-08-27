#!/usr/bin/env bash
#
# Coding-agent seed module: Codex. Sourced by seed.sh; not meant to run on its own.
# The agent is selected by the overlay (environment.d/coding-agent.conf), not by .env.

required_coding_agent=()

validate_coding_agent() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "[seed] Codex is not installed for $(id -un): see 08-coding-agent.md#install." >&2
    exit 1
  fi
}

configure_coding_agent() {
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  echo "[seed] Codex global instructions — $codex_home/AGENTS.md"
  merge_managed_block "$codex_home/AGENTS.md" "$DIR/coding-agent/AGENTS.md" alignfirst-developer
}
