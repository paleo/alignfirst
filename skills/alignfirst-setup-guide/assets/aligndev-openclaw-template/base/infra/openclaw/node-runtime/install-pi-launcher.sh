#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  printf 'Pi launcher installation requires the operator (root).\n' >&2
  exit 1
fi
if [ "$#" -ne 1 ]; then
  printf 'Usage: install-pi-launcher.sh <exact-reviewed-version>\n' >&2
  exit 1
fi
if [ ! -x /usr/bin/node ]; then
  printf 'Pi requires a supported system Node at /usr/bin/node; provision it first.\n' >&2
  exit 1
fi

prefix=/home/{{SERVICE_USER}}/.npm-system-global
package_root="$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
# The immutable prefix anchor prevents replacement through the writable service home.
attributes=$(lsattr -d "$prefix")
if [[ "${attributes%% *}" != *i* ]]; then
  printf 'Restore package hardening before installing the Pi launcher.\n' >&2
  exit 1
fi
launcher=$(mktemp)
trap 'rm -f -- "$launcher"' EXIT
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/pi-launcher.mjs \
  "$package_root" "$1" "$prefix" > "$launcher"
install -d -o root -g root -m 755 /opt/{{SERVICE_USER}}/bin
install -o root -g root -m 755 "$launcher" /opt/{{SERVICE_USER}}/bin/pi
printf 'Installed protected Pi launcher using /usr/bin/node (Pi %s).\n' "$1"
