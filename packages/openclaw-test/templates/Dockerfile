# Consumer-side test runner image. Extends the consumer-agnostic base built locally
# by `openclaw-test env build` and tagged `paleo/openclaw-test-base:<pkg-version>`.
# The CLI passes the matching tag via the OPENCLAW_TEST_BASE_TAG build arg.
#
# Build context is the project dir.

ARG OPENCLAW_TEST_BASE_TAG=__SET_VIA_OPENCLAW_TEST_CLI__
FROM paleo/openclaw-test-base:${OPENCLAW_TEST_BASE_TAG}

COPY --chown=claw:claw package.json package-lock.json /opt/openclaw-test/src/
COPY --chown=claw:claw openclaw.json /home/claw/.openclaw/openclaw.json

RUN npm ci --include=dev && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Consumer customizations below. Add RUN/COPY/ENV as needed. The base image
# is deliberately minimal — add only what your fixtures and scenarios need.
# Common patterns:
#
# * System tools the fixtures invoke (under USER root):
#     RUN apk add --no-cache git
#     RUN corepack enable && corepack prepare pnpm@latest --activate
#
# * Per-command mock-CLI symlinks (the base ships only the bare shim;
#   consumers pick which commands to intercept):
#     USER root
#     RUN for name in claude gh; do \
#           ln -sf mock-cli-shim "/opt/openclaw-test/mocks/bin/$name"; \
#         done
#     USER claw
#
# * Helper scripts invoked from scenarios via `ctx.execInGateway(...)`:
#     USER root
#     COPY --chown=root:root scripts/ /opt/openclaw-test/scripts/
#     RUN chmod +x /opt/openclaw-test/scripts/*.mjs
#     USER claw
#
# * Project fixtures baked into the image (typical with a named-volume
#   /home/claw/projects, then reset/seeded per scenario):
#     COPY --chown=claw:claw projects-fixture/<name>/ /opt/<consumer>/fixtures/<name>/
#     RUN cd /opt/<consumer>/fixtures/<name> && pnpm install --frozen-lockfile --prod=false
#
# * AlignFirst skills under /home/claw/.agents/skills/ for the agent to discover:
#     RUN npx -y skills add https://github.com/paleo/alignfirst --global --yes \
#           --agent universal --agent claude-code \
#           --skill alignfirst --skill al --skill alplan --skill alspec \
#           --skill aldescription --skill alreview --skill alread \
#           --skill almerge --skill alignfirst-agent
