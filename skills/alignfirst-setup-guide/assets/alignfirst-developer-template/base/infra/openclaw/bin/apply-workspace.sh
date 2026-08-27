#!/usr/bin/env bash
#
# Backs up the live OpenClaw workspace files, then overwrites them with the curated versions
# from the seed snapshot. Backup + overwrite only: decide what to push before running it
# (docs/operations/update-workspace.md).
#
# Run as the service account:
#   sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-workspace.sh

set -euo pipefail

SOURCE_BASE="$HOME/seed/workspace"
TARGET_BASE="$HOME/.openclaw/workspace"
BACKUP_DIR="$HOME/backups/workspace-backups/$(date +%Y%m%d-%H%M)"

main() {
  check_preconditions
  apply_files
  print_summary
}

check_preconditions() {
  if [ "$(id -un)" != "{{SERVICE_USER}}" ]; then
    echo "Run as {{SERVICE_USER}}: sudo -i -u {{SERVICE_USER}} -- ~/seed/bin/apply-workspace.sh" >&2
    exit 1
  fi
  if [ ! -d "$SOURCE_BASE" ]; then
    echo "No workspace directory at $SOURCE_BASE — refresh the seed snapshot first." >&2
    exit 1
  fi
}

apply_files() {
  local found=0 src rel target backup
  mkdir -p "$BACKUP_DIR"
  # find + install -D: nested directories and arbitrary file names keep their relative paths in
  # both the target and the backup.
  while IFS= read -r -d '' src; do
    found=1
    rel="${src#"$SOURCE_BASE"/}"
    target="$TARGET_BASE/$rel"
    backup="$BACKUP_DIR/$rel"
    if [ -f "$target" ]; then
      install -D -m 644 "$target" "$backup"
      echo "[apply-workspace] backup: $rel → $backup"
    else
      echo "[apply-workspace] (no backup, target absent) $rel"
    fi
    install -D -m 644 "$src" "$target"
    echo "[apply-workspace] write:  $rel → $target"
  done < <(find "$SOURCE_BASE" -type f \( -name '*.md' -o -name '*.png' -o -name '*.svg' \) -print0)
  if [ "$found" -eq 0 ]; then
    echo "No workspace file (*.md, *.png, *.svg) under $SOURCE_BASE" >&2
    exit 1
  fi
}

print_summary() {
  cat <<SUMMARY

[apply-workspace] Done. Backup at:
                    $BACKUP_DIR

                  New sessions pick up the new files automatically. To refresh active sessions:

                    systemctl --user restart openclaw-gateway
SUMMARY
}

main "$@"
