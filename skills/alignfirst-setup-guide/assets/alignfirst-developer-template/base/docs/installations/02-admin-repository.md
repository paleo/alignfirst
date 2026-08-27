---
title: Admin Repository Setup
read_when:
  - publishing or cloning the generated administration repository
---

# Admin Repository Setup

## Publish the Rendered Repository

**Role: operator machine.** Audit the rendered files before the first commit.

```sh
rg -n '\{\{[A-Z][A-Z0-9_]*\}\}' .
rg -n 'A[D]APT|TEAM_PLANS_SECTIO[N]' .
npm install
npm run validate
git init
git add .
git commit -m 'chore: initialize developer administration'
git remote add origin '{{ADMIN_REPOSITORY_URL}}'
git push -u origin main
```

Both searches must return no matches. Keep the repository private. Do not commit generated
configuration, authentication state, secrets, `node_modules`, or lock files copied from the template
source.

## Clone on the Server

**Role: service user.** A human authenticates to `{{GIT_HOSTS}}` before cloning. Use the organization's
approved SSH key or git-host CLI flow; do not place a token in the clone URL.

```sh
cd '{{PROJECTS_ROOT}}'
git clone '{{ADMIN_REPOSITORY_URL}}' '{{ADMIN_REPOSITORY_NAME}}'
cd '{{ADMIN_REPOSITORY_NAME}}'
npm install
mkdir -p .plans .local
npm run workspace -- setup
npm run docmap
```

## Verify Ownership

```sh
git status --short
find . -maxdepth 2 -not -user '{{SERVICE_USER}}' -print
```

The worktree must be clean and wholly owned by the service user. Continue with
[toolchain setup](03-toolchain.md).
