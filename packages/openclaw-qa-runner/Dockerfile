FROM node:24-alpine

RUN apk add --no-cache shadow git

ARG CLAW_UID=1000
ARG CLAW_GID=1000
RUN (getent passwd ${CLAW_UID} && userdel -r "$(getent passwd ${CLAW_UID} | cut -d: -f1)" || true) && \
    (getent group ${CLAW_GID} && groupdel "$(getent group ${CLAW_GID} | cut -d: -f1)" || true) && \
    groupadd --gid ${CLAW_GID} claw && \
    useradd --create-home --shell /bin/sh --uid ${CLAW_UID} --gid ${CLAW_GID} claw && \
    mkdir -p /home/claw/.openclaw /opt/qa-src /opt/qa-artifacts && \
    chown -R claw:claw /home/claw /opt/qa-src /opt/qa-artifacts

USER claw
WORKDIR /opt/qa-src

# Build context is the consumer project root (QA_PROJECT_DIR, the consumer's `qa/`).
# The consumer pins the four @paleo/openclaw-* packages with absolute host `file:` URIs that
# don't exist inside the image. We stage the host-resolved package contents from the
# consumer's node_modules into an in-image staging dir, then rewrite the package.json
# `file:` URIs to point at the staged copies before `npm install`. Host install must use
# `--install-links` so node_modules/@paleo/* are materialized copies (not symlinks).
COPY --chown=claw:claw package.json package-lock.json* /opt/qa-src/
COPY --chown=claw:claw node_modules/@paleo/openclaw-channel-mock-core/ /opt/qa-staging/openclaw-channel-mock-core/
COPY --chown=claw:claw node_modules/@paleo/openclaw-discord-mock/ /opt/qa-staging/openclaw-discord-mock/
COPY --chown=claw:claw node_modules/@paleo/openclaw-slack-mock/ /opt/qa-staging/openclaw-slack-mock/
COPY --chown=claw:claw node_modules/@paleo/openclaw-qa-runner/ /opt/qa-staging/openclaw-qa-runner/
COPY --chown=claw:claw openclaw.json /home/claw/.openclaw/openclaw.json

# Rewrite absolute host `file:` URIs in package.json to the in-image staging paths.
# The host lockfile pins integrity against the original host paths, so it cannot
# survive the rewrite; `npm ci` would reject it. Drop it and let npm regenerate.
RUN node -e "const fs=require('fs');const p='./package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));for(const k of Object.keys(j.dependencies||{})){if(k.startsWith('@paleo/openclaw-')){const n=k.slice('@paleo/'.length);j.dependencies[k]='file:/opt/qa-staging/'+n;}}fs.writeFileSync(p,JSON.stringify(j,null,2));" && \
    rm -f package-lock.json && \
    npm install --include=dev --install-links && \
    OPENCLAW_CONFIG_PATH=/home/claw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

# Stage the mock-CLI shim under /opt/qa-mocks. PATH is NOT modified at build
# time — image build's own `npm install` above must use the real `npm`.
# OpenClaw's exec tool runs commands via `/bin/sh -lc`, which sources
# /etc/profile. The Alpine /etc/profile resets PATH to a "safe" set that
# excludes /opt/qa-mocks/bin, so we override it to put the mocks first.
USER root
COPY --chown=claw:claw node_modules/@paleo/openclaw-qa-runner/dist/mock-cli-shim.js /opt/qa-mocks/dist/mock-cli-shim.js
RUN mkdir -p /opt/qa-mocks/bin && \
    printf '#!/bin/sh\nexec node /opt/qa-mocks/dist/mock-cli-shim.js "$0" "$@"\n' > /opt/qa-mocks/bin/mock-cli-shim && \
    chmod +x /opt/qa-mocks/bin/mock-cli-shim && \
    for name in git npm pnpm yarn claude; do ln -sf mock-cli-shim "/opt/qa-mocks/bin/$name"; done && \
    chown -R claw:claw /opt/qa-mocks && \
    printf 'export PATH="/opt/qa-mocks/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n' > /etc/profile
USER claw

# Consumer-supplied extra setup, run as claw after the base image is built.
# Use it to install workspace skills, extra system packages, etc. Receives an
# arbitrary shell snippet via the QA_EXTRA_SETUP build arg.
ARG QA_EXTRA_SETUP=""
RUN if [ -n "$QA_EXTRA_SETUP" ]; then sh -c "$QA_EXTRA_SETUP"; fi

CMD ["sleep", "infinity"]
