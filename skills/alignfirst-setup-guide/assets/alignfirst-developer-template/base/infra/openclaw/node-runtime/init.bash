# A login shell can reach this file through both .profile and .bash_profile.
[ -n "${ALIGNFIRST_NODE_INIT:-}" ] && return 0
ALIGNFIRST_NODE_INIT=1
export FNM_DIR=/home/{{SERVICE_USER}}/.local/share/fnm
unset NPM_CONFIG_PREFIX npm_config_prefix
export PATH="/opt/{{SERVICE_USER}}/bin:/usr/local/bin:$PATH:/home/{{SERVICE_USER}}/.npm-system-global/bin"
# Developer children use plain Bash, while OpenClaw keeps project-shell in its own environment.
export SHELL=/bin/bash
shopt -s expand_aliases
if ! fnm_env=$(/usr/local/bin/fnm env --shell bash --use-on-cd \
  --version-file-strategy=recursive --resolve-engines=true 2>/dev/null); then
  printf 'fnm environment initialization failed\n' >&2
  exit 1
fi
eval "$fnm_env"
# Suppress status and install prompts; replay fnm's explanation only on failure.
if ! fnm_output=$(/usr/local/bin/fnm use --silent-if-unchanged 2>&1); then
  printf '%s\n' "$fnm_output" >&2
  exit 1
fi
unset fnm_env fnm_output
# Keep the audited launchers and protected CLIs ahead of the writable fnm runtime.
export PATH="/opt/{{SERVICE_USER}}/bin:/home/{{SERVICE_USER}}/.npm-system-global/bin:$PATH"
