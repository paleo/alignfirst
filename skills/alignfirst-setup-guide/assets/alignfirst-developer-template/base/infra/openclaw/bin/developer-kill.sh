#!/usr/bin/env bash
#
# Kill switch for the AlignFirst Developer service account. Stops the gateway and every
# rootless container, terminates all account workloads, then verifies containment. Only the
# systemd user manager and its (sd-pam) process may survive.
#
# Install and run as root:
#   install -m 755 -o root -g root developer-kill.sh \
#     /usr/local/sbin/alignfirst-developer-kill
#   /usr/local/sbin/alignfirst-developer-kill

set -euo pipefail

SERVICE_USER={{SERVICE_USER}}
SERVICE_HOME=/home/{{SERVICE_USER}}
declare -A PERMITTED_PIDS=()

main() {
  require_root
  require_service_user
  load_permitted_pids
  stop_gateway
  stop_containers
  terminate_workloads TERM
  sleep 2
  terminate_workloads KILL
  sleep 1
  verify_containment
  echo "[kill] $SERVICE_USER is contained"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
  fi
}

require_service_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Unknown service account: $SERVICE_USER" >&2
    exit 1
  fi
  if [ ! -x /usr/bin/podman ]; then
    echo "Podman is required at /usr/bin/podman." >&2
    exit 1
  fi
}

load_permitted_pids() {
  local uid manager_pid control_group init_scope pid comm
  uid=$(id -u "$SERVICE_USER")
  manager_pid=$(systemctl show "user@$uid.service" --property MainPID --value 2>/dev/null || true)
  if [[ "$manager_pid" =~ ^[1-9][0-9]*$ ]] && [ -r "/proc/$manager_pid/comm" ]; then
    read -r comm < "/proc/$manager_pid/comm"
    if [ "$comm" = systemd ]; then PERMITTED_PIDS["$manager_pid"]=1; fi
  fi

  if [[ "$manager_pid" =~ ^[1-9][0-9]*$ ]] && [ -r "/proc/$manager_pid/cgroup" ]; then
    control_group=$(awk -F: '$1 == "0" { print $3 }' "/proc/$manager_pid/cgroup")
  else
    control_group=
  fi
  init_scope="/sys/fs/cgroup${control_group}/cgroup.procs"
  if [ -n "$control_group" ] && [ -r "$init_scope" ]; then
    while read -r pid; do
      [ -r "/proc/$pid/comm" ] || continue
      read -r comm < "/proc/$pid/comm"
      if [ "$comm" = systemd ] || [ "$comm" = "(sd-pam)" ]; then
        PERMITTED_PIDS["$pid"]=1
      fi
    done < "$init_scope"
  fi
}

stop_gateway() {
  local uid
  uid=$(id -u "$SERVICE_USER")
  echo "[kill] stopping openclaw-gateway"
  run_as_service env XDG_RUNTIME_DIR="/run/user/$uid" \
    /usr/bin/systemctl --user stop openclaw-gateway.service 2>/dev/null || true
}

stop_containers() {
  local output containers=()
  echo "[kill] stopping rootless containers"
  output=$(running_containers) || return 1
  if [ -n "$output" ]; then
    mapfile -t containers <<< "$output"
    run_as_service /usr/bin/podman stop --time 5 "${containers[@]}" >/dev/null 2>&1 || true
  fi

  containers=()
  output=$(running_containers) || return 1
  if [ -n "$output" ]; then
    mapfile -t containers <<< "$output"
    run_as_service /usr/bin/podman kill "${containers[@]}" >/dev/null 2>&1 || true
  fi
}

# terminate_workloads <TERM|KILL>
terminate_workloads() {
  local signal=$1 pids=()
  mapfile -t pids < <(workload_pids)
  if [ "${#pids[@]}" -eq 0 ]; then return; fi
  echo "[kill] sending $signal to ${#pids[@]} service-account workload(s)"
  kill "-$signal" "${pids[@]}" 2>/dev/null || true
}

workload_pids() {
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    if [ -z "${PERMITTED_PIDS[$pid]:-}" ]; then printf '%s\n' "$pid"; fi
  done < <(ps -u "$SERVICE_USER" -o pid=)
}

verify_containment() {
  local output pids=()
  output=$(running_containers) || return 1
  mapfile -t pids < <(workload_pids)

  if gateway_is_active; then
    echo "[kill] openclaw-gateway is still active" >&2
    return 1
  fi
  if [ -n "$output" ]; then
    echo "[kill] running rootless containers survived: ${output//$'\n'/ }" >&2
    return 1
  fi
  if [ "${#pids[@]}" -gt 0 ]; then
    echo "[kill] unexpected $SERVICE_USER processes survived:" >&2
    ps -p "$(IFS=,; echo "${pids[*]}")" -o pid,ppid,comm,etime,args >&2 || true
    return 1
  fi
}

running_containers() {
  run_as_service /usr/bin/podman ps --quiet
}

gateway_is_active() {
  local uid
  uid=$(id -u "$SERVICE_USER")
  run_as_service env XDG_RUNTIME_DIR="/run/user/$uid" \
    /usr/bin/systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null
}

run_as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" USER="$SERVICE_USER" \
    LOGNAME="$SERVICE_USER" "$@"
}

main "$@"
