#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
openclaw_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_workspace="$openclaw_dir/workspace"
environment_file=${OPENCLAW_ADMIN_ENV:-"$openclaw_dir/secrets/environment"}

main() {
  load_environment
  validate_paths
  backup_live_workspace
  apply_source_files
}

load_environment() {
  if [ ! -f "$environment_file" ]; then
    echo "Missing environment file: $environment_file" >&2
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  . "$environment_file"
  set +a
}

validate_paths() {
  current_user=$(id -un)
  if [ "${SERVICE_USER-}" != "$current_user" ]; then
    echo "Run as SERVICE_USER=${SERVICE_USER-<unset>}, not $current_user." >&2
    exit 1
  fi
  if [ ! -d "$source_workspace" ]; then
    echo "Workspace source is missing: $source_workspace" >&2
    exit 1
  fi
  case "${OPENCLAW_WORKSPACE-}" in
    /*) ;;
    *) echo "OPENCLAW_WORKSPACE must be an absolute path." >&2; exit 1 ;;
  esac
  if [ "$OPENCLAW_WORKSPACE" = "/" ] || [ "$OPENCLAW_WORKSPACE" = "$HOME" ]; then
    echo "Refusing unsafe OPENCLAW_WORKSPACE: $OPENCLAW_WORKSPACE" >&2
    exit 1
  fi
  if grep -R '{{[A-Z][A-Z0-9_]*}}' "$source_workspace" >/dev/null 2>&1; then
    echo "Workspace source has unresolved placeholders." >&2
    exit 1
  fi
}

backup_live_workspace() {
  backup_root="$openclaw_dir/backups/workspace"
  backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir="$backup_root/$backup_stamp"
  install -d -m 0700 "$backup_dir"
  if [ -d "$OPENCLAW_WORKSPACE" ]; then cp -a "$OPENCLAW_WORKSPACE/." "$backup_dir/"; fi
}

apply_source_files() {
  install -d -m 0700 "$OPENCLAW_WORKSPACE"
  find "$source_workspace" -type d -print | while IFS= read -r source_dir; do
    relative_path=${source_dir#"$source_workspace"}
    install -d -m 0700 "$OPENCLAW_WORKSPACE$relative_path"
  done
  find "$source_workspace" -type f -print | while IFS= read -r source_file; do
    relative_path=${source_file#"$source_workspace/"}
    target_file="$OPENCLAW_WORKSPACE/$relative_path"
    target_mode=0600
    if [ -f "$target_file" ]; then target_mode=$(stat -c '%a' "$target_file"); fi
    install -m "$target_mode" "$source_file" "$target_file"
  done
}

main "$@"
