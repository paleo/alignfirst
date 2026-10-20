#!/usr/bin/env bash
#
# Controlled maintenance window for protected AlignFirst assistant paths. The installed,
# root-owned copy contains the assistant before unlocking named scopes, runs one command as the
# service account, and restores the hardening policy through an EXIT trap.
#
# Usage:
#   alignfirst-assistant-maintenance <scope> [<scope> ...] -- <command> [<argument> ...]
#   alignfirst-assistant-maintenance native-recovery -- <private-native-backup-directory>
#
# Scopes: config, workspace, packages, skills, projects, instructions, agent-skills, agent-config. The config
# scope covers openclaw.json and the aligndev settings (~/.alignfirst/aligndev.settings.json) with their
# directory ~/.alignfirst. The companions directory, with its registry, stays service-owned.

set -Eeuo pipefail

SERVICE_USER={{SERVICE_USER}}
SERVICE_HOME=/home/{{SERVICE_USER}}
ADMIN_USER={{SERVER_ADMIN_USER}}
ADMIN_REPOSITORY=/home/{{SERVER_ADMIN_USER}}/{{ADMIN_REPOSITORY_NAME}}
PROJECTS_MARKER="$SERVICE_HOME/projects/.alignfirst-projects.json"
ALIGNFIRST_HOME="$SERVICE_HOME/.alignfirst"
ALIGNDEV_CONFIG_FILE="$ALIGNFIRST_HOME/aligndev.settings.json"
KILL_SWITCH=/usr/local/sbin/alignfirst-assistant-kill
LIBEXEC=/opt/{{SERVICE_USER}}/libexec
declare -a SCOPES=()
declare -a COMMAND=()
declare -a WORKSPACE_FILES=()
CODING_AGENT=
INSTRUCTION_FILE=
AGENT_SKILLS_DIR=
CLEANUP_ACTIVE=0
INVENTORY_SNAPSHOT_DIR=
NATIVE_RECOVERY=0
RECOVERY_BACKUP=
RECOVERY_SETTINGS_DIR=

main() {
  require_root
  parse_arguments "$@"
  resolve_paths
  "$KILL_SWITCH"
  CLEANUP_ACTIVE=1
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  snapshot_native_inventories
  prepare_recovery_settings
  refresh_seed
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
  if [ "${1:-}" = native-recovery ]; then
    if [ "$#" -ne 3 ] || [ "$2" != -- ] || [ -z "$3" ]; then
      echo "Usage: $0 native-recovery -- <private-native-backup-directory>" >&2
      exit 2
    fi
    NATIVE_RECOVERY=1
    SCOPES=(instructions agent-skills agent-config)
    RECOVERY_BACKUP=$3
    return
  fi
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    scope=$1
    case "$scope" in
      config|workspace|packages|skills|projects|instructions|agent-skills|agent-config) ;;
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
  local config="$ADMIN_REPOSITORY/infra/openclaw/aligndev.settings.json" inventory
  # Read the admin-controlled inventory before containment/unlock. Unsupported stores fail closed.
  inventory=$(read_native_inventory "$config")
  CODING_AGENT=$(jq -r '.agent' <<<"$inventory")
  INSTRUCTION_FILE=$(jq -r '.instructionFile' <<<"$inventory")
  AGENT_SKILLS_DIR=$(jq -r '.skillsDir' <<<"$inventory")
  local action=validate-maintenance
  if [ "$NATIVE_RECOVERY" -eq 1 ]; then action=validate-maintenance-recovery; fi
  /usr/bin/node "$LIBEXEC/deployment-policy.mjs" "$action" \
    "$config" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE"
  if [ -f "$ALIGNDEV_CONFIG_FILE" ]; then
    read_native_inventory "$ALIGNDEV_CONFIG_FILE" >/dev/null
  fi
}

read_native_inventory() {
  local action=inventory
  if [ "$NATIVE_RECOVERY" -eq 1 ]; then action=inventory-recovery; fi
  /usr/bin/node "$LIBEXEC/deployment-policy.mjs" "$action" \
    "$1" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE"
}

snapshot_native_inventories() {
  local settings index=0 action=snapshot
  if [ "$NATIVE_RECOVERY" -eq 1 ]; then action=snapshot-recovery; fi
  INVENTORY_SNAPSHOT_DIR=$(mktemp -d)
  chmod 700 "$INVENTORY_SNAPSHOT_DIR"
  for settings in "$ADMIN_REPOSITORY/infra/openclaw/aligndev.settings.json" "$ALIGNDEV_CONFIG_FILE"; do
    [ -f "$settings" ] || continue
    /usr/bin/node "$LIBEXEC/deployment-policy.mjs" "$action" \
      "$settings" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE" "$INVENTORY_SNAPSHOT_DIR/$index.json"
    if [ "$index" -gt 0 ] && cmp -s "$INVENTORY_SNAPSHOT_DIR/0.json" "$INVENTORY_SNAPSHOT_DIR/$index.json"; then
      rm -f "$INVENTORY_SNAPSHOT_DIR/$index.json"
    fi
    index=$((index + 1))
  done
  if [ "$NATIVE_RECOVERY" -eq 1 ]; then
    # Root can read the service-owned private backup; only validated, profile-rooted resources
    # enter this root-private snapshot. Never unlock raw mapping destinations.
    /usr/bin/node "$LIBEXEC/deployment-policy.mjs" snapshot-backup \
      "$ADMIN_REPOSITORY/infra/openclaw/aligndev.settings.json" \
      "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE" "$RECOVERY_BACKUP" \
      "$INVENTORY_SNAPSHOT_DIR/backup.json"
  fi
}

prepare_recovery_settings() {
  [ "$NATIVE_RECOVERY" -eq 1 ] || return 0
  RECOVERY_SETTINGS_DIR=$(mktemp -d)
  install -m 644 -o root -g root \
    "$ADMIN_REPOSITORY/infra/openclaw/aligndev.settings.json" \
    "$RECOVERY_SETTINGS_DIR/settings.json"
  chmod 755 "$RECOVERY_SETTINGS_DIR"
  COMMAND=(/usr/bin/node "$LIBEXEC/deployment-policy.mjs" recover
    "$RECOVERY_SETTINGS_DIR/settings.json" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE"
    "$RECOVERY_BACKUP")
}

native_policy() {
  local action=$1 scope=$2 status=0 snapshot
  [ -n "$INVENTORY_SNAPSHOT_DIR" ] || return 1
  for snapshot in "$INVENTORY_SNAPSHOT_DIR"/*.json; do
    [ -f "$snapshot" ] || continue
    /usr/bin/node "$LIBEXEC/deployment-policy.mjs" "$action-snapshot" \
      "$snapshot" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE" "$scope" || {
        status=1
        if [ "$action" = unlock ]; then return 1; fi
      }
  done
  return "$status"
}

restore_new_native_resources() {
  local settings status=0
  # Settings may add resources outside the opened scope. Protect all newly valid declarations,
  # independently of the immutable pre-unlock inventory and even if another profile is invalid.
  for settings in "$ADMIN_REPOSITORY/infra/openclaw/aligndev.settings.json" "$ALIGNDEV_CONFIG_FILE"; do
    [ -f "$settings" ] || continue
    /usr/bin/node "$LIBEXEC/deployment-policy.mjs" harden-new \
      "$settings" "$SERVICE_HOME" "$ALIGNDEV_CONFIG_FILE" "$INVENTORY_SNAPSHOT_DIR" || status=1
  done
  return "$status"
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
  local path
  chattr -i "$SERVICE_HOME/.openclaw/openclaw.json"
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.openclaw/openclaw.json"
  for path in "$ALIGNFIRST_HOME" "$ALIGNDEV_CONFIG_FILE"; do
    [ -e "$path" ] || continue
    chattr -i "$path"
    chown "$SERVICE_USER:$SERVICE_USER" "$path"
  done
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
  chown -Rh "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.npm-system-global"
}

unlock_skills() {
  native_policy unlock agent-skills
  chattr -i "$SERVICE_HOME/.agents"
  chown -Rh "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.agents"
  if [ -d "$SERVICE_HOME/.openclaw/skills" ]; then
    chattr -i "$SERVICE_HOME/.openclaw/skills"
    chown -Rh "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.openclaw/skills"
  fi
}

unlock_projects() {
  [ -e "$PROJECTS_MARKER" ] || return 0
  chattr -i "$PROJECTS_MARKER"
  chown "$SERVICE_USER:$SERVICE_USER" "$PROJECTS_MARKER"
}

unlock_instructions() {
  native_policy unlock instructions
}

unlock_agent_skills() {
  native_policy unlock agent-skills
}

unlock_agent_config() {
  native_policy unlock agent-config
}

cleanup() {
  local command_status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [ "$CLEANUP_ACTIVE" -eq 0 ]; then exit "$command_status"; fi
  set +e

  if ! "$KILL_SWITCH"; then
    echo "[maintenance] RECONTAINMENT FAILED; gateway state unknown; no privileged repair attempted" >&2
    echo "[maintenance] retain private inventory for manual recovery: $INVENTORY_SNAPSHOT_DIR" >&2
    exit 1
  fi
  if [ -n "$RECOVERY_SETTINGS_DIR" ]; then rm -rf -- "$RECOVERY_SETTINGS_DIR"; fi
  restore_scopes
  if [ "$?" -ne 0 ]; then cleanup_status=1; fi
  restore_new_native_resources
  if [ "$?" -ne 0 ]; then cleanup_status=1; fi
  if [ "$cleanup_status" -eq 0 ] && [ -n "$INVENTORY_SNAPSHOT_DIR" ]; then
    rm -rf -- "$INVENTORY_SNAPSHOT_DIR"
  fi

  if [ "$cleanup_status" -ne 0 ]; then
    echo "[maintenance] hardening restoration failed; gateway remains stopped; inventory: $INVENTORY_SNAPSHOT_DIR" >&2
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

validate_managed_paths() {
  /usr/bin/node --input-type=module -e '
    const { rejectSymlinks } = await import(process.argv[2]);
    for (const path of process.argv.slice(3)) rejectSymlinks(path, true);
  ' maintenance-path-check "$LIBEXEC/deployment-profiles.mjs" "$@"
}

restore_config() {
  local status=0
  validate_managed_paths "$SERVICE_HOME/.openclaw/openclaw.json" \
    "$ALIGNDEV_CONFIG_FILE" || return 1
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.openclaw/openclaw.json" &&
    chmod 600 "$SERVICE_HOME/.openclaw/openclaw.json" &&
    chattr +i "$SERVICE_HOME/.openclaw/openclaw.json" || status=1
  if [ -e "$ALIGNDEV_CONFIG_FILE" ]; then
    chown root:root "$ALIGNDEV_CONFIG_FILE" &&
      chmod 644 "$ALIGNDEV_CONFIG_FILE" &&
      chattr +i "$ALIGNDEV_CONFIG_FILE" || status=1
  fi
  if [ -d "$ALIGNFIRST_HOME" ]; then
    chown root:root "$ALIGNFIRST_HOME" &&
      chmod 755 "$ALIGNFIRST_HOME" &&
      chattr +i "$ALIGNFIRST_HOME" || status=1
  fi
  return "$status"
}

restore_workspace() {
  validate_managed_paths "$SERVICE_HOME/.openclaw/workspace" || return 1
  collect_workspace_files
  if [ "${#WORKSPACE_FILES[@]}" -eq 0 ]; then return; fi
  chown "$SERVICE_USER:$SERVICE_USER" "${WORKSPACE_FILES[@]}" &&
    chmod 644 "${WORKSPACE_FILES[@]}" &&
    chattr +i "${WORKSPACE_FILES[@]}"
}

restore_packages() {
  /usr/bin/node --input-type=module -e '
    const { validateManagedTree } = await import(process.argv[2]);
    const root = process.argv[3];
    validateManagedTree(root, [root]);
  ' maintenance-package-check "$LIBEXEC/deployment-profiles.mjs" \
    "$SERVICE_HOME/.npm-system-global" || return 1
  chown -Rh root:root "$SERVICE_HOME/.npm-system-global" &&
    chmod -R go-w "$SERVICE_HOME/.npm-system-global" &&
    chattr +i "$SERVICE_HOME/.npm-system-global"
}

restore_skills() {
  local status=0
  # Another selected scope may already have re-hardened these descendants.
  native_policy unlock agent-skills || return 1
  restore_tree "$SERVICE_HOME/.agents" || status=1
  if [ -d "$SERVICE_HOME/.openclaw/skills" ]; then
    restore_tree "$SERVICE_HOME/.openclaw/skills" || status=1
  fi
  native_policy harden agent-skills || status=1
  return "$status"
}

restore_projects() {
  validate_managed_paths "$PROJECTS_MARKER" || return 1
  [ -e "$PROJECTS_MARKER" ] || return 0
  chown root:root "$PROJECTS_MARKER" &&
    chmod 644 "$PROJECTS_MARKER" &&
    chattr +i "$PROJECTS_MARKER"
}

restore_instructions() {
  native_policy harden instructions
}

restore_agent_skills() {
  native_policy harden agent-skills
}

restore_agent_config() {
  native_policy harden agent-config
}

restore_tree() {
  local path=$1
  validate_managed_paths "$path" || return 1
  chown -Rh "$ADMIN_USER:$ADMIN_USER" "$path" &&
    find "$path" -type d -exec chmod 755 {} + &&
    find "$path" -type f -perm /111 -exec chmod 755 {} + &&
    find "$path" -type f ! -perm /111 -exec chmod 644 {} + &&
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
  path="/usr/bin:/opt/{{SERVICE_USER}}/bin:/bin:$SERVICE_HOME/.npm-system-global/bin:$SERVICE_HOME/.local/bin"
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" USER="$SERVICE_USER" \
    LOGNAME="$SERVICE_USER" XDG_RUNTIME_DIR="/run/user/$uid" PATH="$path" \
    bash -c 'cd "$HOME" && exec "$@"' bash "${COMMAND[@]}"
}

main "$@"
