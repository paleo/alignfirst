#!/bin/sh
# Gateway entrypoint for the Dev Kit harness image. Imports the mounted Codex
# subscription credential, then hands off to the command the base Compose stack
# defines, so the gateway start line stays owned by @alignfirst/openclaw-test.
#
# Version-specific (OpenClaw 2026.9.6 and later): the runtime reads no Codex
# `auth.json` directly, so the credential has to reach OpenClaw's own auth store.
# See docs/alignfirst-dev-kit/upgrading-openclaw.md for the removal condition.
#
# The import is deliberately not fatal. A stale or partial Codex credential must
# fail the openai/Terra cells only, not keep the gateway from starting and take
# the Sonnet, GLM and qwen matrices down with it.

set -u

CODEX_AUTH=/home/assistant/.codex/auth.json

if [ -f "$CODEX_AUTH" ]; then
  # The mount is read-only and `migrate apply` wants a writable source dir.
  import_home=$(mktemp -d)
  trap 'rm -rf "$import_home"' EXIT
  cp "$CODEX_AUTH" "$import_home/auth.json"
  # --no-backup (which upstream gates behind --force) skips a verified archive of
  # disposable container state, paid once per force-recreated gateway.
  if ! npx openclaw migrate apply codex \
    --from "$import_home" --agent main --include-secrets --item auth:openai \
    --no-backup --force --yes; then
    echo "gateway-entrypoint: Codex credential import failed; openai models will not authenticate" >&2
  fi
  rm -rf "$import_home"
  trap - EXIT
fi

# Fatal, unlike the import: every delegation reads its coding agent from this config.
node -e '
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { dirname } = require("node:path");
  const [file] = process.argv.slice(1);
  const agent = process.env.CODING_AGENT;
  if (agent !== "claude" && agent !== "codex") {
    const got = JSON.stringify(agent);
    console.error(`gateway-entrypoint: CODING_AGENT must be claude or codex, got ${got}`);
    process.exit(1);
  }
  const models = (process.env.CODING_AGENT_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  const config = {
    platform: "openclaw",
    projectsRoot: "/home/assistant/projects",
    code: models.length > 0 ? { agent, models } : { agent },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
' "$HOME/.config/alignfirst/aligndev.config.json" || exit 1

exec "$@"
