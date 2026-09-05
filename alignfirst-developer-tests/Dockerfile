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
    mkdir -p /home/claw/projects && \
    chown claw:claw /home/claw/projects

# PATH wrappers for the real CLIs. `/opt/alignfirst` is the read-only monorepo root
# mount, so @paleo/docmap, arktype, and semver resolve through its root node_modules.
# `alproject` spawns `alignfirst`. The mocked coding agent never runs the stub
# skills, so no `npx -y alignfirst` resolution is needed.
RUN printf '#!/bin/sh\nexec node /opt/alignfirst/packages/alcode/bin/alcode.mjs "$@"\n' > /usr/local/bin/alcode && \
    printf '#!/bin/sh\nexec node /opt/alignfirst/packages/alignfirst/bin/alignfirst.mjs "$@"\n' > /usr/local/bin/alignfirst && \
    printf '#!/bin/sh\nexec node /opt/alignfirst/packages/alproject/bin/alproject.mjs "$@"\n' > /usr/local/bin/alproject && \
    chmod +x /usr/local/bin/alcode /usr/local/bin/alignfirst /usr/local/bin/alproject

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

# OpenClaw 2026.8 verifies managed plugin dependencies and capabilities at
# gateway startup. Install the exact official artifacts instead of copying the
# local package directory, which omits its runtime dependencies. Z.AI backs the
# configured GLM model; Perplexity is auto-selected when OpenRouter is present.
RUN npm ci --include=dev && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json \
      npx openclaw plugins install --force --accept-capabilities \
        npm:@openclaw/codex@2026.8.2 && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json \
      npx openclaw plugins install --force --accept-capabilities \
        npm:@openclaw/zai-provider@2026.8.2 && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json \
      npx openclaw plugins install --force --accept-capabilities \
        npm:@openclaw/perplexity-plugin@2026.8.2 && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json \
      npx openclaw plugins registry --refresh && \
    npm cache clean --force

# Single fixture template baked into the image. scripts/reset-fixture.mjs copies
# from here into the nested fixture tree at scenario start, materializing nimbus,
# lumen, and external-team project orion with per-name patches.
COPY --chown=claw:claw projects-fixture/template/ /opt/alignfirst-developer-tests/fixtures/template/
RUN cd /opt/alignfirst-developer-tests/fixtures/template && \
    pnpm install --frozen-lockfile --prod=false

# Install AlignFirst skills under /home/claw/.agents/skills/ (the path OpenClaw scans).
RUN npx -y skills add https://github.com/paleo/alignfirst --global --yes \
      --agent universal --agent claude-code \
      --skill alignfirst --skill al --skill alplan --skill alspec \
      --skill aldescription --skill alreview --skill alcatchup \
      --skill almerge --skill alignfirst-setup-guide \
      --skill alignfirst-developer-openclaw-playbook

USER root
RUN corepack install --global pnpm@latest
USER claw
