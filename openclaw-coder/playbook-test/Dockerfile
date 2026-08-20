# Consumer-side test runner image. Extends the consumer-agnostic base built locally
# by `openclaw-test env build` and tagged `paleo/openclaw-test-base:<pkg-version>`.
# The CLI passes the matching tag via the OPENCLAW_TEST_BASE_TAG build arg.
#
# Build context is the project dir.

ARG OPENCLAW_TEST_BASE_TAG=__SET_VIA_OPENCLAW_TEST_CLI__
FROM paleo/openclaw-test-base:${OPENCLAW_TEST_BASE_TAG}

USER root

# Fixture runtime deps (git for `git init` / worktree, curl for the playbook's
# verification step — "confirm the app still serves" — pnpm via Corepack for
# the project's dev scripts). Plus the per-command mock-cli shim symlinks
# this consumer wants intercepted. `claude`, `codex`, and `gh` are shimmed. `alcode` runs for real,
# and its selected coding-agent subprocess resolves back to the shim via PATH order.
RUN apk add --no-cache git curl && \
    corepack enable && corepack prepare pnpm@latest --activate && \
    for name in claude codex gh; do ln -sf mock-cli-shim "/opt/openclaw-test/mocks/bin/$name"; done && \
    mkdir -p /home/claw/projects && chown claw:claw /home/claw/projects

# PATH wrapper for the real `@paleo/alcode` CLI. The package's built output is
# live-mounted at /opt/alcode (`${ALIGNFIRST_CODE_DIR}:/opt/alcode:ro` in the compose
# overlay), so alcode edits iterate without a rebuild — mirroring the skill
# live-mount. `/usr/local/bin` sits after `/opt/openclaw-test/mocks/bin` in
# PATH, so this wrapper is only reached for `alcode` (never shimmed), while
# alcode's own coding-agent subprocess still hits the shim.
RUN printf '#!/bin/sh\nexec node /opt/alcode/bin/alcode.mjs "$@"\n' > /usr/local/bin/alcode && \
    chmod +x /usr/local/bin/alcode

# PATH wrapper for the `openclaw` CLI. OpenClaw is only a local npm dependency
# of /opt/openclaw-test/src (nothing puts its node_modules/.bin on the exec
# PATHs), yet the alcode guide chains `openclaw system event …` onto every
# delegated run for the completion wake. The server's `--auth none` flag does
# not exempt the CLI: it checks credentials client-side from the config, so
# openclaw.json also declares `gateway.auth.mode: "none"`.
RUN printf '#!/bin/sh\nexec /opt/openclaw-test/src/node_modules/.bin/openclaw "$@"\n' > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw

# Reset / seed scripts invoked from scenarios via ctx.execInGateway(...).
COPY --chown=root:root scripts/ /opt/openclaw-test/scripts/
RUN chmod +x /opt/openclaw-test/scripts/*.mjs

USER claw

# Pin pnpm's content-addressable store outside /home/claw/projects/, which is a
# docker volume on its own filesystem. Without this, pnpm walks up from a
# worktree install target and creates /home/claw/projects/.pnpm-store, polluting
# the project listing the agent grounds project names in. Cost: pnpm falls back
# to copy instead of hardlinks across filesystems — irrelevant at fixture size.
RUN printf 'store-dir=/home/claw/.pnpm-store\n' > /home/claw/.pnpmrc && \
    mkdir -p /home/claw/.pnpm-store

# The @paleo/openclaw-* packages install from locally-built tarballs under
# vendor/ (see scripts/vendor-packages.mjs), not from npmjs — so the image tests
# this checkout without a publish. `npm run env:build` repacks + relocks before
# this build; the tarballs must sit in the build context for the `file:` deps to
# resolve during `npm ci`.
COPY --chown=claw:claw package.json package-lock.json /opt/openclaw-test/src/
COPY --chown=claw:claw vendor/ /opt/openclaw-test/src/vendor/
COPY --chown=claw:claw openclaw.json /home/claw/.openclaw/openclaw.json

RUN npm ci --include=dev && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Single fixture template baked into the image. scripts/reset-fixture.mjs copies
# from here to /home/claw/projects/<name> at scenario start, materializing the
# distinct projects (nimbus, lumen) with per-name patches.
COPY --chown=claw:claw projects-fixture/template/ /opt/playbook-test/fixtures/template/
RUN cd /opt/playbook-test/fixtures/template && \
    pnpm install --frozen-lockfile --prod=false

# Install AlignFirst skills under /home/claw/.agents/skills/ (the path OpenClaw scans).
RUN npx -y skills add https://github.com/paleo/alignfirst --global --yes \
      --agent universal --agent claude-code \
      --skill alignfirst --skill al --skill alplan --skill alspec \
      --skill aldescription --skill alreview --skill alread \
      --skill almerge --skill openclaw-coder-playbook
