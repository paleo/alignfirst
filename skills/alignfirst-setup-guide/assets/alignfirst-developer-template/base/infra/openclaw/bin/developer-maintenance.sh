#!/usr/bin/env bash
#
# Controlled maintenance window for protected AlignFirst Developer paths. The installed,
# root-owned copy contains the developer before unlocking named scopes, runs one command as the
# service account, and restores the hardening policy through an EXIT trap.
#
# Usage:
#   alignfirst-developer-maintenance <scope> [<scope> ...] -- <command> [<argument> ...]
#
# Scopes: config, workspace, packages, skills, projects, instructions, agent-skills.

set -Eeuo pipefail

SERVICE_USER={{SERVICE_USER}}
SERVICE_HOME=/home/{{SERVICE_USER}}
ADMIN_USER={{SERVER_ADMIN_USER}}
ADMIN_REPOSITORY=/home/{{SERVER_ADMIN_USER}}/{{ADMIN_REPOSITORY_NAME}}
PROJECTS_MARKER="$SERVICE_HOME/projects/.alignfirst-projects.json"
KILL_SWITCH=/usr/local/sbin/alignfirst-developer-kill
declare -a SCOPES=()
declare -a COMMAND=()
declare -a WORKSPACE_FILES=()
CODING_AGENT=
INSTRUCTION_FILE=
AGENT_SKILLS_DIR=
CLEANUP_ACTIVE=0

main() {
  require_root
  parse_arguments "$@"
  resolve_paths
  "$KILL_SWITCH"
  refresh_seed
  CLEANUP_ACTIVE=1
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  unlock_scopes
  run_as_service
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $0 <scope> -- <command>" >&2
    exit 1
  fi
  if [ ! -x "$KILL_SWITCH" ]; then
    echo "Missing root-owned kill switch: $KILL_SWITCH" >&2
    exit 1
  fi
}

parse_arguments() {
  local scope seen=" "
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    scope=$1
    case "$scope" in
      config|workspace|packages|skills|projects|instructions|agent-skills) ;;
      *) echo "Unknown maintenance scope: $scope" >&2; exit 2 ;;
    esac
    if [[ "$seen" = *" $scope "* ]]; then
      echo "Duplicate maintenance scope: $scope" >&2
      exit 2
    fi
    SCOPES+=("$scope")
    seen+="$scope "
    shift
  done
  if [ "${#SCOPES[@]}" -eq 0 ] || [ "${1:-}" != -- ]; then
    echo "Usage: $0 <scope> [<scope> ...] -- <command> [<argument> ...]" >&2
    exit 2
  fi
  shift
  if [ "$#" -eq 0 ]; then
    echo "A service-account command is required after --." >&2
    exit 2
  fi
  COMMAND=("$@")
}

resolve_paths() {
  local config="$ADMIN_REPOSITORY/infra/openclaw/environment.d/coding-agent.conf"
  if [ -r "$config" ]; then
    CODING_AGENT=$(sed -n 's/^ALIGNFIRST_CODE_AGENT=//p' "$config" | tail -1)
  fi
  case "$CODING_AGENT" in
    codex)
      INSTRUCTION_FILE="$SERVICE_HOME/.codex/AGENTS.md"
      AGENT_SKILLS_DIR="$SERVICE_HOME/.codex/skills"
      ;;
    claude)
      INSTRUCTION_FILE="$SERVICE_HOME/.claude/CLAUDE.md"
      AGENT_SKILLS_DIR="$SERVICE_HOME/.claude/skills"
      ;;
    *) echo "Cannot determine the coding agent from $config." >&2; exit 1 ;;
  esac
}

refresh_seed() {
  echo "[maintenance] refreshing the contained seed snapshot"
  rsync -a --delete "$ADMIN_REPOSITORY/infra/openclaw/" "$SERVICE_HOME/seed/"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/seed"
}

unlock_scopes() {
  local scope method
  for scope in "${SCOPES[@]}"; do
    echo "[maintenance] unlocking $scope"
    method=${scope//-/_}
    "unlock_$method"
  done
}

unlock_config() {
  chattr -i "$SERVICE_HOME/.openclaw/openclaw.json"
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.openclaw/openclaw.json"
}

unlock_workspace() {
  collect_workspace_files
  if [ "${#WORKSPACE_FILES[@]}" -gt 0 ]; then
    chattr -i "${WORKSPACE_FILES[@]}"
    chown "$SERVICE_USER:$SERVICE_USER" "${WORKSPACE_FILES[@]}"
  fi
}

unlock_packages() {
  chattr -i "$SERVICE_HOME/.npm-system-global"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.npm-system-global"
}

unlock_skills() {
  chattr -i "$SERVICE_HOME/.agents"
  chown -Rh "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.agents"
  if [ "$CODING_AGENT" = claude ]; then
    chattr -i "$AGENT_SKILLS_DIR"
    chown -Rh "$SERVICE_USER:$SERVICE_USER" "$AGENT_SKILLS_DIR"
  fi
}

unlock_projects() {
  chattr -i "$PROJECTS_MARKER"
  chown "$SERVICE_USER:$SERVICE_USER" "$PROJECTS_MARKER"
}

unlock_instructions() {
  chattr -i "$INSTRUCTION_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTRUCTION_FILE"
}

unlock_agent_skills() {
  chattr -i "$AGENT_SKILLS_DIR"
  chown -Rh "$SERVICE_USER:$SERVICE_USER" "$AGENT_SKILLS_DIR"
}

cleanup() {
  local command_status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [ "$CLEANUP_ACTIVE" -eq 0 ]; then exit "$command_status"; fi
  set +e

  "$KILL_SWITCH"
  if [ "$?" -ne 0 ]; then cleanup_status=1; fi
  restore_scopes
  if [ "$?" -ne 0 ]; then cleanup_status=1; fi

  if [ "$cleanup_status" -ne 0 ]; then
    echo "[maintenance] containment or hardening restoration failed; gateway remains stopped" >&2
  fi
  if [ "$command_status" -ne 0 ]; then
    echo "[maintenance] command failed with status $command_status; gateway remains stopped" >&2
    exit "$command_status"
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    exit 1
  fi
  echo "[maintenance] hardening restored; gateway remains stopped"
}

restore_scopes() {
  local index scope method status=0
  for ((index=${#SCOPES[@]} - 1; index >= 0; index--)); do
    scope=${SCOPES[index]}
    method=${scope//-/_}
    echo "[maintenance] restoring $scope"
    "restore_$method" || status=1
  done
  return "$status"
}

restore_config() {
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.openclaw/openclaw.json" &&
    chmod 600 "$SERVICE_HOME/.openclaw/openclaw.json" &&
    chattr +i "$SERVICE_HOME/.openclaw/openclaw.json"
}

restore_workspace() {
  collect_workspace_files
  if [ "${#WORKSPACE_FILES[@]}" -eq 0 ]; then return; fi
  chown "$SERVICE_USER:$SERVICE_USER" "${WORKSPACE_FILES[@]}" &&
    chmod 644 "${WORKSPACE_FILES[@]}" &&
    chattr +i "${WORKSPACE_FILES[@]}"
}

restore_packages() {
  chown -R root:root "$SERVICE_HOME/.npm-system-global" &&
    chmod -R go-w "$SERVICE_HOME/.npm-system-global" &&
    chattr +i "$SERVICE_HOME/.npm-system-global"
}

restore_skills() {
  local status=0
  restore_tree "$SERVICE_HOME/.agents" || status=1
  if [ "$CODING_AGENT" = claude ]; then restore_tree "$AGENT_SKILLS_DIR" || status=1; fi
  return "$status"
}

restore_projects() {
  chown root:root "$PROJECTS_MARKER" &&
    chmod 644 "$PROJECTS_MARKER" &&
    chattr +i "$PROJECTS_MARKER"
}

restore_instructions() {
  chown "$ADMIN_USER:$ADMIN_USER" "$INSTRUCTION_FILE" &&
    chmod 644 "$INSTRUCTION_FILE" &&
    chattr +i "$INSTRUCTION_FILE"
}

restore_agent_skills() {
  restore_tree "$AGENT_SKILLS_DIR"
}

restore_tree() {
  local path=$1
  chown -Rh "$ADMIN_USER:$ADMIN_USER" "$path" &&
    find "$path" -type d -exec chmod 755 {} + &&
    find "$path" -type f -exec chmod 644 {} + &&
    chattr +i "$path"
}

collect_workspace_files() {
  mapfile -d '' -t WORKSPACE_FILES < <(find "$SERVICE_HOME/.openclaw/workspace" \
    -path "$SERVICE_HOME/.openclaw/workspace/scratch" -prune -o -type f \
    \( -name '*.md' -o -name '*.png' -o -name '*.svg' \) -print0)
}

run_as_service() {
  local uid path
  uid=$(id -u "$SERVICE_USER")
  path="/usr/bin:/bin:$SERVICE_HOME/.npm-system-global/bin:$SERVICE_HOME/.local/bin"
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" USER="$SERVICE_USER" \
    LOGNAME="$SERVICE_USER" XDG_RUNTIME_DIR="/run/user/$uid" PATH="$path" \
    bash -c 'cd "$HOME" && exec "$@"' bash "${COMMAND[@]}"
}

main "$@"
