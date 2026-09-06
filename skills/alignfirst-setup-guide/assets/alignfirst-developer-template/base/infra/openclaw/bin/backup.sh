#!/usr/bin/env bash
#
# Copies the deployment state of the service account into ~/backups/deployment/<stamp>/:
# openclaw.json, the secret store, the gateway env file, the workspace files, environment.d,
# the alproject registry when present, OpenClaw's archive, and thread-handoff's independent state.
#
# Run as the service account:
#   sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh

set -euo pipefail
umask 077

BACKUP_BASE="$HOME/backups/deployment"
BACKUP_DIR=
WORKSPACE="$HOME/.openclaw/workspace"
# Unquoted so a ~-prefixed PROJECTS_ROOT expands.
REGISTRY_FILE={{PROJECTS_ROOT}}/alproject-registry.json

main() {
  check_user
  create_backup_dir
  copy_file "$HOME/.openclaw/openclaw.json" openclaw.json
  copy_file "$HOME/.openclaw/secrets/secrets.json" secrets.json
  copy_file "$HOME/.openclaw/.env" openclaw.env
  copy_workspace
  copy_environment
  copy_file "$REGISTRY_FILE" alproject-registry.json
  create_openclaw_archive
  copy_thread_handoff_state
  chmod -R go-rwx "$BACKUP_DIR"
  echo "$BACKUP_DIR"
}

# OpenClaw's archive holds what the plain copies above cannot: the SQLite state (sessions, cron
# jobs and their scratch, plugin consent, device pairing) and the auth profiles. The workspace is
# already copied.
create_openclaw_archive() {
  openclaw backup create --output "$BACKUP_DIR" --no-include-workspace --verify >/dev/null
}

# The gateway must be stopped before backup.sh runs. Preserve every SQLite crash-state file rather
# than assuming the main database contains a completed checkpoint.
copy_thread_handoff_state() {
  local source="$HOME/.openclaw/thread-handoff" file
  if [ ! -d "$source" ]; then
    echo "[backup] absent, skipped: $source" >&2
    return
  fi
  for file in "$source"/state.sqlite "$source"/state.sqlite-wal "$source"/state.sqlite-shm; do
    if [ -f "$file" ]; then copy_file "$file" "thread-handoff/${file##*/}"; fi
  done
}

create_backup_dir() {
  install -d -m 700 "$BACKUP_BASE"
  BACKUP_DIR=$(mktemp -d "$BACKUP_BASE/$(date +%Y%m%d-%H%M%S)-XXXXXX")
  chmod 700 "$BACKUP_DIR"
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
