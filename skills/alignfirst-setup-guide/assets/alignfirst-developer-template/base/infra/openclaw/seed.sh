#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
environment_file=${OPENCLAW_ADMIN_ENV:-"$script_dir/secrets/environment"}

main() {
  load_environment
  load_modules
  validate_inputs
  establish_baseline
  configure_common
  configure_surface
  configure_coding_agent
  validate_effective_configuration
  protect_runtime_files
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

load_modules() {
  common_module="$script_dir/seed/common.sh"
  surface_module="$script_dir/seed/surface.sh"
  coding_agent_module="$script_dir/seed/coding-agent.sh"

  missing_modules=""
  for module in "$common_module" "$surface_module" "$coding_agent_module"; do
    if [ ! -f "$module" ]; then missing_modules="$missing_modules\n  $module"; fi
  done
  if [ -n "$missing_modules" ]; then
    printf 'Selected template overlays are incomplete. Missing:%b\n' "$missing_modules" >&2
    exit 1
  fi

  # shellcheck source=seed/common.sh
  . "$common_module"
  # shellcheck source=/dev/null
  . "$surface_module"
  # shellcheck source=/dev/null
  . "$coding_agent_module"
}

validate_inputs() {
  command -v openclaw >/dev/null 2>&1 || {
    echo "openclaw is not installed for the service user." >&2
    exit 1
  }

  require_functions validate_common configure_common validate_surface configure_surface \
    validate_coding_agent configure_coding_agent
  validate_common
  validate_surface
  validate_coding_agent
}

require_functions() {
  missing_functions=""
  for function_name in "$@"; do
    if ! command -v "$function_name" >/dev/null 2>&1; then
      missing_functions="$missing_functions $function_name"
    fi
  done
  if [ -n "$missing_functions" ]; then
    echo "Overlay module contract missing functions:$missing_functions" >&2
    exit 1
  fi
}

establish_baseline() {
  openclaw --version
  openclaw config --help >/dev/null
  openclaw config validate >/dev/null 2>&1 || {
    echo "OpenClaw has no valid installed-version baseline. Run the human onboarding step first." >&2
    exit 1
  }
}

validate_effective_configuration() {
  openclaw config validate
  openclaw secrets audit
}

protect_runtime_files() {
  chmod 0700 "$(dirname -- "$OPENCLAW_SECRET_ENV")" "$OPENCLAW_WORKSPACE"
  chmod 0600 "$environment_file" "$OPENCLAW_SECRET_ENV"
}

main "$@"
