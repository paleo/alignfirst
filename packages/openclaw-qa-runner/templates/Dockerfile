# Consumer-side QA runner image. Extends the consumer-agnostic base built locally
# by `openclaw-qa-runner env build` and tagged `paleo/openclaw-qa-runner-base:<pkg-version>`.
# The CLI passes the matching tag via the QA_RUNNER_BASE_TAG build arg.
#
# Build context is this `qa/` directory.

ARG QA_RUNNER_BASE_TAG
FROM paleo/openclaw-qa-runner-base:${QA_RUNNER_BASE_TAG}

# Stage the host-resolved @paleo/openclaw-* packages into an in-image staging dir,
# then rewrite the consumer `package.json`'s absolute host `file:` URIs to point
# at the staged copies before `npm install`. Host install must use `--install-links`
# so `node_modules/@paleo/*` are materialized copies (not symlinks).
COPY --chown=claw:claw package.json package-lock.json* /opt/qa-src/
COPY --chown=claw:claw node_modules/@paleo/openclaw-channel-mock-core/ /opt/qa-staging/openclaw-channel-mock-core/
COPY --chown=claw:claw node_modules/@paleo/openclaw-discord-mock/ /opt/qa-staging/openclaw-discord-mock/
COPY --chown=claw:claw node_modules/@paleo/openclaw-slack-mock/ /opt/qa-staging/openclaw-slack-mock/
COPY --chown=claw:claw node_modules/@paleo/openclaw-qa-runner/ /opt/qa-staging/openclaw-qa-runner/
COPY --chown=claw:claw openclaw.json /home/claw/.openclaw/openclaw.json

# The host lockfile pins integrity against the original host paths; it cannot
# survive the URI rewrite, so drop it and let npm regenerate.
RUN node -e "const fs=require('fs');const p='./package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));for(const k of Object.keys(j.dependencies||{})){if(k.startsWith('@paleo/openclaw-')){const n=k.slice('@paleo/'.length);j.dependencies[k]='file:/opt/qa-staging/'+n;}}fs.writeFileSync(p,JSON.stringify(j,null,2));" && \
    rm -f package-lock.json && \
    npm install --include=dev --install-links && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Consumer customizations below. Add RUN/COPY/ENV as needed.
# Example: install AlignFirst skills into /home/claw/.agents/skills/ for the agent to discover.
#
# RUN npx -y skills add https://github.com/paleo/alignfirst --global --yes \
#       --agent universal --agent claude-code \
#       --skill alignfirst --skill al --skill alplan --skill alspec \
#       --skill aldescription --skill alreview --skill alread \
#       --skill almerge --skill alignfirst-coaching
