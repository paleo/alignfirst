#!/usr/bin/env bash
#
# Common OpenClaw baseline and the helpers every seed module may call.
# Sourced by seed.sh; not meant to run on its own.

required_common=(
  RUNTIME_PROVIDER RUNTIME_MODEL GATEWAY_AUTH_TOKEN GATEWAY_DASHBOARD_ORIGIN CONTEXT7_API_KEY
)
secret_variables_common=(GATEWAY_AUTH_TOKEN)
# A SecretRef provider alias must match ^[a-z][a-z0-9_-]{0,63}$ (upstream zod-schema.core.ts).
secrets_provider_id="$(printf '%s' '{{DEVELOPER_NAME}}' | tr '[:upper:]' '[:lower:]')file"

set_scalar() { openclaw config set "$1" "$2"; }
set_json() { openclaw config set "$1" --json "$2"; }

# set_json_tolerated <path> <json> <reason>: for keys the installed version may have removed.
set_json_tolerated() {
  set_json "$1" "$2" || echo "[seed] skipped $1: $3"
}

unset_key() { openclaw config unset "$1" || true; }

# ref <pointer>: SecretRef into the file provider registered by seed.sh. The pointer is a JSON
# pointer into secrets.json, so the variable NAME is reached as /NAME.
ref() { printf '{"source":"file","provider":"%s","id":"%s"}' "$secrets_provider_id" "$1"; }
set_secret_ref() { set_json "$1" "$(ref "$2")"; }

# merge_managed_block <target-file> <source-file> <block-name>: replaces the block between
# `<!-- name:start -->` and `<!-- name:end -->` in the target with the source content, keeps the
# rest of the file, and writes nothing when the result already equals the target (a re-seed then
# succeeds while 06 keeps the file immutable).
merge_managed_block() {
  local target_file=$1 source_file=$2 block_name=$3
  local begin_marker="<!-- $block_name:start -->" end_marker="<!-- $block_name:end -->"
  local remainder="" merged
  install -d -m 700 "$(dirname -- "$target_file")"
  if [ -f "$target_file" ]; then
    remainder=$(sed "/^$begin_marker\$/,/^$end_marker\$/d" "$target_file")
  fi
  merged=$(mktemp)
  {
    if [ -n "$remainder" ]; then printf '%s\n\n' "$remainder"; fi
    printf '%s\n' "$begin_marker"
    sed -e '$a\' "$source_file"
    printf '%s\n' "$end_marker"
  } > "$merged"
  if [ -f "$target_file" ] && cmp -s "$merged" "$target_file"; then
    rm -f "$merged"
    return
  fi
  install -m 600 "$merged" "$target_file"
  rm -f "$merged"
}

# require_variables <name>...: fails listing every missing or empty variable.
require_variables() {
  local name missing=()
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("$name"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[seed] missing or empty in .env: ${missing[*]}" >&2
    exit 1
  fi
}

validate_common() {
  if [ "$(id -un)" != "{{SERVICE_USER}}" ]; then
    echo "[seed] run as {{SERVICE_USER}}, not $(id -un):" \
      "sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/seed.sh" >&2
    exit 1
  fi
  local command_name
  for command_name in openclaw node; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "[seed] $command_name is not on PATH." >&2
      exit 1
    fi
  done
  case "$GATEWAY_DASHBOARD_ORIGIN" in
    http*) ;;
    *) echo "[seed] GATEWAY_DASHBOARD_ORIGIN must start with http." >&2; exit 1 ;;
  esac
}

configure_common() {
  echo "[seed] model and workspace"
  set_scalar agents.defaults.workspace "$HOME/.openclaw/workspace"
  set_scalar agents.defaults.model.primary "$RUNTIME_PROVIDER/$RUNTIME_MODEL"
  set_json agents.defaults.model.fallbacks '[]'
  if [ -n "${RUNTIME_API_KEY:-}" ]; then
    set_secret_ref "models.providers.$RUNTIME_PROVIDER.apiKey" /RUNTIME_API_KEY
  fi
  # Semantic recall is unused; disabled so it never binds a provider of its own.
  set_json_tolerated agents.defaults.memorySearch.enabled false \
    "key removed upstream after 2026.7 (config-surface reduction); harmless when rejected"

  echo "[seed] heartbeat — on, one periodic tick a day"
  # Heartbeat stays on: the alcode completion wake is a heartbeat-sourced turn. `every` only
  # governs periodic ticks. isolatedSession, lightContext and activeHours would each break the
  # wake (throwaway session, no workspace bootstrap, deferred run), so they are cleared.
  set_scalar agents.defaults.heartbeat.every "24h"
  set_scalar agents.defaults.heartbeat.prompt \
    "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. \
Do not infer or repeat old tasks from prior chats. \
If nothing needs attention, reply exactly NO_REPLY."
  # Drops the built-in "reply exactly: HEARTBEAT_OK" section, which contradicts NO_REPLY.
  set_json_tolerated agents.defaults.heartbeat.includeSystemPromptSection false \
    "key removed upstream after 2026.7 (config-surface reduction); harmless when rejected"
  unset_key agents.defaults.heartbeat.isolatedSession
  unset_key agents.defaults.heartbeat.lightContext
  unset_key agents.defaults.heartbeat.activeHours

  echo "[seed] skill allowlist"
  # `clawhub` is deliberately absent: the agent cannot install skills on its own. The `al*`
  # command skills belong to the delegated coding agent only.
  set_json agents.defaults.skills \
    '["alignfirst","alignfirst-setup-guide","alignfirst-developer-openclaw-playbook","sharp-writing"]'

  echo "[seed] tools"
  set_scalar tools.profile coding
  # The coding profile omits `message`; the playbook needs `read`, thread actions, attachments.
  set_json tools.alsoAllow '["message"]'
  set_json agents.defaults.sandbox.browser.headless true
  set_scalar messages.groupChat.visibleReplies automatic

  echo "[seed] thread sessions — 2.5 days idle, binding kept as long"
  # Threads carry one task across days; the default daily reset and 24h binding would drop
  # them overnight.
  set_json session.resetByType.thread '{"mode":"idle","idleMinutes":3600}'
  set_json session.threadBindings '{"enabled":true,"idleHours":60,"maxAgeHours":0}'

  echo "[seed] agent identity"
  set_json agents.list '[{"id":"main","identity":{"name":"{{DEVELOPER_NAME}}"}}]'

  echo "[seed] gateway — loopback, token auth, dashboard through an SSH tunnel"
  set_json gateway.port 18789
  set_scalar gateway.bind loopback
  set_scalar gateway.auth.mode token
  set_secret_ref gateway.auth.token /GATEWAY_AUTH_TOKEN
  set_json gateway.controlUi.allowedOrigins \
    "[\"$GATEWAY_DASHBOARD_ORIGIN\",\"http://127.0.0.1:18789\"]"

  echo "[seed] plugins — explicit allowlist"
  # A provider served by an additional OpenClaw plugin (a runtime harness, for example) needs
  # `plugins.entries.<id>.enabled true` and its id appended to `plugins.allow` here; the runbook
  # 04 shows the form.
  set_json plugins.allow "[\"$surface_plugin_id\",\"$RUNTIME_PROVIDER\"]"
  set_json_tolerated plugins.bundledDiscovery '"allowlist"' "key removed upstream after 2026.7"
}
