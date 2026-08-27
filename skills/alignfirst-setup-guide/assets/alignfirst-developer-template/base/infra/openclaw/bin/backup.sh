#!/usr/bin/env bash
#
# Copies the deployment state of the service account into ~/backups/deployment/<stamp>/:
# openclaw.json, the secret store, the gateway env file, the workspace files, environment.d,
# and the alproject registry when present.
#
# Run as the service account:
#   sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh

set -euo pipefail

BACKUP_DIR="$HOME/backups/deployment/$(date +%Y%m%d-%H%M)"
WORKSPACE="$HOME/.openclaw/workspace"
# Unquoted so a ~-prefixed PROJECTS_ROOT expands.
REGISTRY_FILE={{PROJECTS_ROOT}}/alproject-registry.json

main() {
  check_user
  install -d -m 700 "$BACKUP_DIR"
  copy_file "$HOME/.openclaw/openclaw.json" openclaw.json
  copy_file "$HOME/.openclaw/secrets/secrets.json" secrets.json
  copy_file "$HOME/.openclaw/.env" openclaw.env
  copy_workspace
  copy_environment
  copy_file "$REGISTRY_FILE" alproject-registry.json
  chmod -R go-rwx "$BACKUP_DIR"
  echo "$BACKUP_DIR"
}

check_user() {
  if [ "$(id -un)" != "{{SERVICE_USER}}" ]; then
    echo "Run as {{SERVICE_USER}}: sudo -i -u {{SERVICE_USER}} -- ~/seed/bin/backup.sh" >&2
    exit 1
  fi
}

# copy_file <source> <relative-target>: skips an absent source with a notice.
copy_file() {
  if [ -f "$1" ]; then
    install -D -m 600 "$1" "$BACKUP_DIR/$2"
  else
    echo "[backup] absent, skipped: $1" >&2
  fi
}

copy_workspace() {
  local src
  # Same enumeration as apply-workspace.sh; scratch/ holds artifacts, not workspace files.
  while IFS= read -r -d '' src; do
    install -D -m 600 "$src" "$BACKUP_DIR/workspace/${src#"$WORKSPACE"/}"
  done < <(find "$WORKSPACE" -path "$WORKSPACE/scratch" -prune -o -type f \
    \( -name '*.md' -o -name '*.png' -o -name '*.svg' \) -print0)
}

copy_environment() {
  local conf
  for conf in "$HOME"/.config/environment.d/*.conf; do
    if [ -f "$conf" ]; then install -D -m 600 "$conf" "$BACKUP_DIR/environment.d/${conf##*/}"; fi
  done
}

main "$@"
