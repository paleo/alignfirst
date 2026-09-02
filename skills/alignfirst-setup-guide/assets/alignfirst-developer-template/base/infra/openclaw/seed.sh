#!/usr/bin/env bash
#
# Idempotent OpenClaw configuration seeder.
#
# Strategy: `openclaw setup` produces the installed version's default config; every
# customization then goes through `openclaw config set`, which runs the validator and migrates
# across versions. Secrets are derived from .env into ~/.openclaw/secrets/secrets.json and
# reach openclaw.json as file SecretRefs only.
#
# Run as the service account, from the seed snapshot:
#   sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/seed.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
OPENCLAW_HOME="$HOME/.openclaw"
SECRETS_FILE="$OPENCLAW_HOME/secrets/secrets.json"
GATEWAY_ENV_FILE="$OPENCLAW_HOME/.env"
ENVIRONMENT_DIR="$HOME/.config/environment.d"

main() {
  load_env
  load_modules
  # `${array[@]+"${array[@]}"}` keeps `set -u` quiet when a module declares an empty array.
  require_variables "${required_common[@]}" \
    ${required_surface[@]+"${required_surface[@]}"} \
    ${required_coding_agent[@]+"${required_coding_agent[@]}"}
  validate_common
  validate_surface
  validate_coding_agent
  prepare_filesystem
  write_secrets_store
  write_gateway_env
  ensure_config
  register_secrets_provider
  configure_common
  configure_surface
  configure_coding_agent
  install_environment_files
  verify
}

load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "[seed] missing $ENV_FILE — copy .env.example to .env, fill it in," \
      "then refresh the snapshot." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

load_modules() {
  local module missing=()
  for module in common surface coding-agent; do
    if [ ! -f "$DIR/seed/$module.sh" ]; then missing+=("seed/$module.sh"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[seed] missing in $DIR: ${missing[*]} — the rendered overlays are incomplete." >&2
    exit 1
  fi
  # shellcheck source=seed/common.sh
  . "$DIR/seed/common.sh"
  # shellcheck source=/dev/null
  . "$DIR/seed/surface.sh"
  # shellcheck source=/dev/null
  . "$DIR/seed/coding-agent.sh"
  local function_name
  for function_name in validate_common configure_common validate_surface configure_surface \
    validate_coding_agent configure_coding_agent; do
    if ! declare -F "$function_name" >/dev/null; then
      echo "[seed] $function_name is not defined by the seed modules." >&2
      exit 1
    fi
  done
  if [ -z "${surface_plugin_id:-}" ]; then
    echo "[seed] surface_plugin_id is not defined by seed/surface.sh." >&2
    exit 1
  fi
}

prepare_filesystem() {
  echo "[seed] filesystem"
  # scratch/ sits inside the workspace because the workspace is a static media root read by
  # both delivery paths (MEDIA: and message attachments). It is not a bootstrap file and
  # apply-workspace.sh never enumerates it.
  mkdir -p "$OPENCLAW_HOME/workspace/scratch" "$ENVIRONMENT_DIR" \
    "$HOME/.cache/openclaw-compile-cache"
  install -d -m 700 "$OPENCLAW_HOME/secrets"
}

write_secrets_store() {
  echo "[seed] secret store — $SECRETS_FILE"
  local names=("${secret_variables_common[@]}" \
    ${secret_variables_surface[@]+"${secret_variables_surface[@]}"})
  if [ -n "${RUNTIME_API_KEY:-}" ]; then names+=(RUNTIME_API_KEY); fi
  # Names travel as arguments; node reads the values from its environment, so no value reaches
  # a command line, and JSON.stringify escapes them.
  node -e '
    const { writeFileSync } = require("node:fs");
    const [file, ...names] = process.argv.slice(1);
    const secrets = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  ' "$SECRETS_FILE" "${names[@]}"
  chmod 600 "$SECRETS_FILE"
}

write_gateway_env() {
  echo "[seed] gateway env file — $GATEWAY_ENV_FILE"
  # Sole occupant: credentials that external CLIs read per call. Nothing else goes here.
  printf 'CONTEXT7_API_KEY=%s\n' "$CONTEXT7_API_KEY" > "$GATEWAY_ENV_FILE"
  chmod 600 "$GATEWAY_ENV_FILE"
}

ensure_config() {
  if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
    echo "[seed] initializing the config with openclaw setup"
    openclaw setup
  fi
}

register_secrets_provider() {
  echo "[seed] secrets provider — file provider over the secret store"
  # Registered before the first ref, so the final config resolves.
  set_json "secrets.providers.$secrets_provider_id" \
    '{"source":"file","path":"'"$SECRETS_FILE"'","mode":"json"}'
}

install_environment_files() {
  echo "[seed] environment.d — $ENVIRONMENT_DIR"
  install -m 644 "$DIR"/environment.d/*.conf "$ENVIRONMENT_DIR"/
  # environment.d does not expand variables, hence the generated file.
  printf 'DOCKER_HOST=unix:///run/user/%s/podman/podman.sock\n' "$(id -u)" \
    > "$ENVIRONMENT_DIR/runtime.conf"
  echo "[seed] a changed variable needs: systemctl --user daemon-reexec, then a gateway restart"
}

verify() {
  audit_secrets
  echo "[seed] config validate"
  openclaw config validate
  echo "[seed] doctor (interactive; the first install adds --fix once, see 04-openclaw.md)"
  openclaw doctor
  echo "[seed] done. Apply with: systemctl --user restart openclaw-gateway"
}

audit_secrets() {
  echo "[seed] secrets audit"
  # Not `--check`: it fails on every finding, including the info-level LEGACY_RESIDUE that a
  # provider OAuth login (04-openclaw.md § 10) always produces. Fail on the actionable counters.
  openclaw secrets audit --json | node -e '
    const report = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const summary = report.summary;
    const failures = summary.plaintextCount + summary.unresolvedRefCount +
      summary.shadowedRefCount + summary.storeResidueCount;
    console.log(`[seed] secrets audit: ${JSON.stringify(summary)}`);
    if (failures > 0) {
      console.error(JSON.stringify(report.findings, null, 2));
      process.exit(1);
    }
  '
}

main "$@"
