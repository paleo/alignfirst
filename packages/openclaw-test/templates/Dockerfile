# Consumer-side test runner image. Extends the consumer-agnostic base built locally
# by `openclaw-test env build` and tagged `paleo/openclaw-test-base:<pkg-version>`.
# The CLI passes the matching tag via the OPENCLAW_TEST_BASE_TAG build arg.
#
# Build context is the project dir.

ARG OPENCLAW_TEST_BASE_TAG=__SET_VIA_OPENCLAW_TEST_CLI__
FROM paleo/openclaw-test-base:${OPENCLAW_TEST_BASE_TAG}

COPY --chown=assistant:assistant package.json package-lock.json /opt/openclaw-test/src/
COPY --chown=assistant:assistant openclaw.json /home/assistant/.openclaw/openclaw.json

RUN npm ci --include=dev && \
    OPENCLAW_CONFIG_PATH=/home/assistant/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Consumer customizations below. Add RUN/COPY/ENV as needed. The base image
# is deliberately minimal — add only what your fixtures and scenarios need.
# Common patterns:
#
# * System tools the fixtures invoke (under USER root):
#     RUN apk add --no-cache git
#     RUN npm install --global corepack@0.36.0 && \
#         corepack enable && corepack prepare pnpm@latest --activate
#
# * Per-command mock-CLI symlinks (the base ships only the bare shim;
#   consumers pick which commands to intercept):
#     USER root
#     RUN for name in claude gh; do \
#           ln -sf mock-cli-shim "/opt/openclaw-test/mocks/bin/$name"; \
#         done
#     USER assistant
#
# * Helper scripts invoked from scenarios via `ctx.execInGateway(...)`:
#     USER root
#     COPY --chown=root:root scripts/ /opt/openclaw-test/scripts/
#     RUN chmod +x /opt/openclaw-test/scripts/*.mjs
#     USER assistant
#
# * Project fixtures baked into the image (typical with a named-volume
#   /home/assistant/projects, then reset/seeded per scenario):
#     COPY --chown=assistant:assistant projects-fixture/<name>/ /opt/<consumer>/fixtures/<name>/
#     RUN cd /opt/<consumer>/fixtures/<name> && pnpm install --frozen-lockfile
#
# * Skills under /home/assistant/.agents/skills/ for the assistant to discover
#   (e.g. installed with the `skills` CLI from any repo or registry):
#     RUN npx -y skills add <skills-source> --global --yes \
#           --agent claude-code --skill <name> [--skill <name> …]
