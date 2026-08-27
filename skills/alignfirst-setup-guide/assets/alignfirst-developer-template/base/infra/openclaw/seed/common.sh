#!/bin/sh

validate_common() {
  require_environment SERVICE_USER DEVELOPER_NAME PROJECTS_ROOT TIME_ZONE OPENCLAW_RUNTIME_PROVIDER \
    OPENCLAW_RUNTIME_MODEL OPENCLAW_WORKSPACE OPENCLAW_SECRET_ENV OPENCLAW_SERVICE_NAME

  current_user=$(id -un)
  if [ "$current_user" != "$SERVICE_USER" ]; then
    echo "Run seed.sh as SERVICE_USER=$SERVICE_USER, not $current_user." >&2
    exit 1
  fi

  case "$OPENCLAW_WORKSPACE" in
    /*) ;;
    *) echo "OPENCLAW_WORKSPACE must be an absolute path." >&2; exit 1 ;;
  esac
}

require_environment() {
  missing_variables=""
  for variable_name in "$@"; do
    eval "variable_value=\${$variable_name-}"
    if [ -z "$variable_value" ]; then missing_variables="$missing_variables $variable_name"; fi
  done
  if [ -n "$missing_variables" ]; then
    echo "Missing required environment variables:$missing_variables" >&2
    exit 1
  fi
}

configure_common() {
  install -d -m 0700 "$OPENCLAW_WORKSPACE" "$(dirname -- "$OPENCLAW_SECRET_ENV")"
  if [ "$environment_file" != "$OPENCLAW_SECRET_ENV" ]; then
    install -m 0600 "$environment_file" "$OPENCLAW_SECRET_ENV"
  fi

  set_config_string agents.defaults.workspace "$OPENCLAW_WORKSPACE"
  set_config_string agents.defaults.model.primary \
    "$OPENCLAW_RUNTIME_PROVIDER/$OPENCLAW_RUNTIME_MODEL"
  set_config_string tools.profile coding
  set_config_json agents.defaults.skills '["alignfirst-developer-openclaw-playbook"]'
  set_config_json agents.defaults.heartbeat.includeSystemPromptSection false
}

set_config_string() {
  openclaw config set "$1" "$2"
}

set_config_json() {
  openclaw config set "$1" "$2" --json
}

set_secret_ref() {
  config_path=$1
  environment_name=$2
  eval "secret_value=\${$environment_name-}"
  if [ -z "$secret_value" ]; then
    echo "Missing secret environment variable: $environment_name" >&2
    exit 1
  fi

  secret_ref=$(printf '{"source":"env","provider":"default","id":"%s"}' "$environment_name")
  set_config_json "$config_path" "$secret_ref"
}
