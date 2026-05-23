# Consumer-side QA runner image. Extends the consumer-agnostic base built locally
# by `openclaw-qa-runner env build` and tagged `paleo/openclaw-qa-runner-base:<pkg-version>`.
# The CLI passes the matching tag via the QA_RUNNER_BASE_TAG build arg.
#
# Build context is this `qa/` directory.

ARG QA_RUNNER_BASE_TAG
FROM paleo/openclaw-qa-runner-base:${QA_RUNNER_BASE_TAG}

COPY --chown=claw:claw package.json package-lock.json /opt/qa-src/
COPY --chown=claw:claw openclaw.json /home/claw/.openclaw/openclaw.json

RUN npm ci --include=dev && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Consumer customizations below. Add RUN/COPY/ENV as needed.
# Example: install AlignFirst skills into /home/claw/.agents/skills/ for the agent to discover.
#
# RUN npx -y skills add https://github.com/paleo/alignfirst --global --yes \
#       --agent universal --agent claude-code \
#       --skill alignfirst --skill al --skill alplan --skill alspec \
#       --skill aldescription --skill alreview --skill alread \
#       --skill almerge --skill alignfirst-coaching
