#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
openclaw_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
environment_file=${OPENCLAW_ADMIN_ENV:-"$openclaw_dir/secrets/environment"}

main() {
  load_environment
  validate_owner
  create_backup
}

load_environment() {
  set -a
  # shellcheck source=/dev/null
  . "$environment_file"
  set +a
}

validate_owner() {
  if [ "$(id -un)" != "$SERVICE_USER" ]; then
    echo "Run backup.sh as $SERVICE_USER." >&2
    exit 1
  fi
}

create_backup() {
  backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir="$openclaw_dir/backups/deployment/$backup_stamp"
  install -d -m 0700 "$backup_dir"
  cp -a "$OPENCLAW_WORKSPACE" "$backup_dir/workspace"
  cp -a "$OPENCLAW_SECRET_ENV" "$backup_dir/environment"
  openclaw config get >"$backup_dir/effective-config.json"
  chmod -R go-rwx "$backup_dir"
  echo "$backup_dir"
}

main "$@"
