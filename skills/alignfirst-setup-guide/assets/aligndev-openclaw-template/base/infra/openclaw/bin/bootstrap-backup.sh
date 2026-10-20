#!/usr/bin/env bash
# Schema-independent snapshot before replacing a legacy deployment's seed or settings.
# Run only after the operator has contained the service account.
set -euo pipefail
umask 077

main() {
  if [ "$#" -ne 0 ]; then
    echo "Usage: bootstrap-backup.sh" >&2
    exit 1
  fi
  if [ "$(id -un)" != "{{SERVICE_USER}}" ]; then
    echo "Run as {{SERVICE_USER}} after containing the account." >&2
    exit 1
  fi
  if [ -L "$HOME/backups" ] || [ -L "$HOME/backups/bootstrap" ]; then
    echo "Bootstrap backup destinations must not be symlinks." >&2
    exit 1
  fi

  local base="$HOME/backups/bootstrap" destination
  install -d -m 700 "$HOME/backups" "$base"
  destination=$(mktemp -d "$base/$(date +%Y%m%d-%H%M%S)-XXXXXX")
  # Retain original modes and links inside a private archive. Never dereference legacy skill links.
  tar --create --gzip --file "$destination/service-home.tar.gz.partial" \
    --directory "$HOME" --exclude=./backups .
  tar --list --gzip --file "$destination/service-home.tar.gz.partial" >/dev/null
  mv "$destination/service-home.tar.gz.partial" "$destination/service-home.tar.gz"
  printf '%s\n' 'Complete service-home snapshot; excludes only ./backups; links are not followed.' \
    > "$destination/COMPLETE"
  echo "$destination"
}

main "$@"
