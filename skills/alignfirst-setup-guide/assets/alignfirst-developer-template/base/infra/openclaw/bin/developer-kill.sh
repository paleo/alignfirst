#!/usr/bin/env bash
#
# Kill switch: stops the gateway unit of {{SERVICE_USER}}, then terminates every remaining
# agent process of the account — node, claude, codex, alcode (container payloads included:
# rootless podman runs them under the same uid). The systemd --user manager stays up.
#
# Run as root, from the admin account:
#   sudo ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/developer-kill.sh
#
# Recovery:
#   sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway

set -euo pipefail

SERVICE_USER={{SERVICE_USER}}

main() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
  fi
  stop_gateway
  echo "[kill] terminating the remaining agent processes"
  signal_agents TERM
  sleep 5
  signal_agents KILL
  echo "[kill] surviving $SERVICE_USER processes (expected: systemd --user, (sd-pam), podman):"
  ps -u "$SERVICE_USER" -o pid,comm,etime || true
}

stop_gateway() {
  local uid
  uid=$(id -u "$SERVICE_USER")
  echo "[kill] stopping openclaw-gateway"
  runuser -u "$SERVICE_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
    systemctl --user stop openclaw-gateway.service || true
}

# signal_agents <TERM|KILL>
signal_agents() {
  local name
  for name in node claude codex; do
    pkill "-$1" -u "$SERVICE_USER" -x "$name" 2>/dev/null || true
  done
  pkill "-$1" -u "$SERVICE_USER" -f alcode 2>/dev/null || true
}

main "$@"
