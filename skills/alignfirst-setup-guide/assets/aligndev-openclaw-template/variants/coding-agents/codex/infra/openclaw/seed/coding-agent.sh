#!/usr/bin/env bash
#
# Coding-agent seed module: Codex. Sourced by seed.sh; not meant to run on its own.
# The agent is selected by the overlay (aligndev.settings.json, the aligndev settings), not by .env.

required_coding_agent=()
coding_agent_kind=codex

validate_coding_agent() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "[seed] Codex is not installed for $(id -un): see 08-coding-agent.md#install." >&2
    exit 1
  fi
}

configure_coding_agent() {
  echo "[seed] Codex global instructions — $INSTRUCTION_FILE"
  merge_managed_block "$INSTRUCTION_FILE" "$DIR/coding-agent/AGENTS.md" alignfirst-dev-kit
}
