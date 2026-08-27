#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
openclaw_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
environment_file=${OPENCLAW_ADMIN_ENV:-"$openclaw_dir/secrets/environment"}

main() {
  load_environment
  validate_owner
  resolve_targets
  stop_targets
}

load_environment() {
  set -a
  # shellcheck source=/dev/null
  . "$environment_file"
  set +a
}

validate_owner() {
  current_user=$(id -un)
  if [ "$current_user" != "$SERVICE_USER" ]; then
    echo "Run developer-kill.sh as $SERVICE_USER, not $current_user." >&2
    exit 1
  fi
}

resolve_targets() {
  service_state=$(systemctl --user is-active "$OPENCLAW_SERVICE_NAME" 2>/dev/null || true)
  service_uid=$(id -u "$SERVICE_USER")
  alcode_pids=$(pgrep -u "$service_uid" -f '(^|/)alcode([[:space:]]|$)' || true)
  printf 'Service: %s (%s)\n' "$OPENCLAW_SERVICE_NAME" "$service_state"
  printf 'alcode PIDs: %s\n' "${alcode_pids:-none}"
}

stop_targets() {
  systemctl --user stop "$OPENCLAW_SERVICE_NAME"
  if [ -n "$alcode_pids" ]; then
    kill -TERM $alcode_pids
    wait_for_exit
  fi
}

wait_for_exit() {
  deadline=$(( $(date +%s) + 10 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    remaining=""
    for process_id in $alcode_pids; do
      if kill -0 "$process_id" 2>/dev/null; then remaining="$remaining $process_id"; fi
    done
    if [ -z "$remaining" ]; then return; fi
    sleep 1
  done
  kill -KILL $remaining
}

main "$@"
