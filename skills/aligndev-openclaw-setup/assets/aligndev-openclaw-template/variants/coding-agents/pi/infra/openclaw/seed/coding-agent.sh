#!/usr/bin/env bash
# Sourced by seed.sh. The overlay selects the agent, not OpenClaw's model provider.

required_coding_agent=()
coding_agent_kind=pi

validate_coding_agent() {
  if [ "$(command -v pi 2>/dev/null)" != /opt/{{SERVICE_USER}}/bin/pi ]; then
    echo "[seed] Pi must use /opt/{{SERVICE_USER}}/bin/pi: see 08-coding-agent.md#install." >&2
    exit 1
  fi
  if ! PI_OFFLINE=1 pi --version >/dev/null; then
    echo "[seed] Pi cannot start with system Node: see 08-coding-agent.md#install." >&2
    exit 1
  fi
}

configure_coding_agent() {
  echo "[seed] Pi global instructions — $INSTRUCTION_FILE"
  merge_managed_block "$INSTRUCTION_FILE" "$DIR/coding-agent/AGENTS.md" alignfirst-dev-kit
}
