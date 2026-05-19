FROM node:24-alpine

RUN apk add --no-cache shadow

ARG KCLAW_UID=1000
ARG KCLAW_GID=1000
RUN (getent passwd ${KCLAW_UID} && userdel -r "$(getent passwd ${KCLAW_UID} | cut -d: -f1)" || true) && \
    (getent group ${KCLAW_GID} && groupdel "$(getent group ${KCLAW_GID} | cut -d: -f1)" || true) && \
    groupadd --gid ${KCLAW_GID} kclaw && \
    useradd --create-home --shell /bin/sh --uid ${KCLAW_UID} --gid ${KCLAW_GID} kclaw && \
    mkdir -p /home/kclaw/.openclaw /opt/qa-src /opt/qa-artifacts && \
    chown -R kclaw:kclaw /home/kclaw /opt/qa-src /opt/qa-artifacts

USER kclaw
WORKDIR /opt/qa-src

# Build context is the consumer project root (QA_PROJECT_DIR, the consumer's `qa/`).
# The consumer pins the four @paleo/openclaw-* packages with absolute host `file:` URIs that
# don't exist inside the image. We stage the host-resolved package contents from the
# consumer's node_modules into an in-image staging dir, then rewrite the package.json
# `file:` URIs to point at the staged copies before `npm install`. Host install must use
# `--install-links` so node_modules/@paleo/* are materialized copies (not symlinks).
COPY --chown=kclaw:kclaw package.json package-lock.json* /opt/qa-src/
COPY --chown=kclaw:kclaw node_modules/@paleo/openclaw-channel-mock-core/ /opt/qa-staging/openclaw-channel-mock-core/
COPY --chown=kclaw:kclaw node_modules/@paleo/openclaw-discord-mock/ /opt/qa-staging/openclaw-discord-mock/
COPY --chown=kclaw:kclaw node_modules/@paleo/openclaw-slack-mock/ /opt/qa-staging/openclaw-slack-mock/
COPY --chown=kclaw:kclaw node_modules/@paleo/openclaw-qa-runner/ /opt/qa-staging/openclaw-qa-runner/
COPY --chown=kclaw:kclaw openclaw.json /home/kclaw/.openclaw/openclaw.json

# Rewrite absolute host `file:` URIs in package.json to the in-image staging paths.
RUN node -e "const fs=require('fs');const p='./package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));for(const k of Object.keys(j.dependencies||{})){if(k.startsWith('@paleo/openclaw-')){const n=k.slice('@paleo/'.length);j.dependencies[k]='file:/opt/qa-staging/'+n;}}fs.writeFileSync(p,JSON.stringify(j,null,2));" && \
    rm -f package-lock.json && \
    npm install --include=dev --install-links && \
    OPENCLAW_CONFIG_PATH=/home/kclaw/.openclaw/openclaw.json npx openclaw plugins registry --refresh

CMD ["sleep", "infinity"]
